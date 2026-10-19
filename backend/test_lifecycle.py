import importlib.util
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).with_name('lifecycle.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.sessions = {t:dict(hash=None,expires=9000,seen=1000) for t in ('one','two','three')}
        self.streams, self.calls = {}, []
        self.registry = module.Registry(self.sessions,self.streams,self.engine,max_viewers=2,grace=60,clock=lambda:self.now)
        self.link='magnet:?xt=urn:btih:'+'a'*40

    def engine(self, request):
        self.calls.append(request)
        return {'hash':module.torrent_key(request['link'])} if request['action']=='add' else {}

    def stream(self, owner, key):
        self.streams[key]=dict(owner=owner,hash='a'*40,expires=9000,cancel=threading.Event())

    def test_shared_cache_independent_readers_and_last_owner_cleanup(self):
        self.registry.attach('one',self.link); self.registry.attach('two',self.link)
        self.stream('one','first'); self.stream('two','second')
        first=self.registry.acquire('first'); second=self.registry.acquire('second')
        self.registry.detach('one')
        self.assertFalse(self.registry.alive(first)); self.assertTrue(self.registry.alive(second))
        self.registry.release(first); self.registry.reap()
        self.assertEqual(len(self.calls),1)
        self.registry.detach('two'); self.now+=61; self.registry.reap()
        self.assertIn('a'*40,self.registry.torrents) # still an open reader
        self.registry.release(second); self.now+=61; self.registry.reap()
        self.assertEqual(self.registry.torrents,{})
        self.assertEqual([c['action'] for c in self.calls],['add','rem'])

    def test_warm_cache_reused_then_expires(self):
        self.registry.attach('one',self.link); self.registry.detach('one'); self.now+=20
        self.registry.attach('two',self.link)
        self.assertEqual(len(self.calls),1)
        self.registry.detach('two'); self.now+=61; self.registry.reap()
        self.assertEqual(self.registry.torrents,{})

    def test_unused_other_hash_evicted_but_active_hash_preserved(self):
        self.registry.attach('one',self.link)
        other='magnet:?xt=urn:btih:'+'b'*40
        with self.assertRaises(module.Busy): self.registry.attach('two',other)
        self.registry.detach('one'); self.registry.attach('two',other)
        self.assertEqual([c['action'] for c in self.calls],['add','rem','add'])

    def test_stop_during_add_cannot_resurrect_session(self):
        started, finish = threading.Event(),threading.Event()
        def engine(request):
            if request['action']=='add': started.set(); self.assertTrue(finish.wait(3))
            return self.engine(request)
        self.registry.engine=engine
        failures=[]
        def adding():
            try:self.registry.attach('one',self.link)
            except module.Busy:failures.append('cancelled')
        worker=threading.Thread(target=adding);worker.start()
        self.assertTrue(started.wait(2));self.registry.detach('one');finish.set();worker.join(3)
        self.assertFalse(worker.is_alive());self.assertEqual(failures,['cancelled'])
        self.assertIsNone(self.sessions['one']['hash'])
        self.now+=61;self.registry.reap();self.assertFalse(self.registry.torrents)

    def test_concurrent_same_hash_add_is_single_flight(self):
        started,finish=threading.Event(),threading.Event()
        def engine(request):
            if request['action']=='add':started.set();finish.wait(3)
            return self.engine(request)
        self.registry.engine=engine;errors=[]
        def adding(token):
            try:self.registry.attach(token,self.link)
            except Exception as error: errors.append(error)
        first=threading.Thread(target=adding,args=('one',));first.start();self.assertTrue(started.wait(2))
        second=threading.Thread(target=adding,args=('two',));second.start();finish.set()
        first.join(3);second.join(3)
        self.assertFalse(first.is_alive() or second.is_alive());self.assertEqual(errors,[])
        self.assertEqual(sum(c['action']=='add' for c in self.calls),1)

    def test_live_reader_survives_background_heartbeat_throttle(self):
        self.registry.attach('one',self.link);self.stream('one','first');reader=self.registry.acquire('first')
        self.now+=400;self.assertNotIn('one',self.registry.expired())
        self.registry.release(reader);self.now+=301;self.assertIn('one',self.registry.expired())

    def test_failed_delete_remains_tracked_for_retry(self):
        self.registry.attach('one',self.link);self.registry.detach('one');self.now+=61
        def failing(request):raise TimeoutError()
        self.registry.engine=failing;self.registry.reap()
        self.assertEqual(self.registry.torrents['a'*40]['state'],'failed')
        self.registry.engine=self.engine;self.now+=61;self.registry.reap();self.assertFalse(self.registry.torrents)

    def test_magnet_trackers_and_webseeds_are_not_forwarded(self):
        self.registry.attach('one',self.link+'&tr=http://127.0.0.1/private&ws=http://evil.test')
        self.assertEqual(self.calls[0]['link'],self.link)
