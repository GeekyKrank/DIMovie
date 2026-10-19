import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch, MagicMock
import io
import time

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('player_bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = bridge.Server(('127.0.0.1', 0), bridge.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        bridge.SESSIONS.clear(); bridge.STREAMS.clear(); bridge.ATTEMPTS.clear(); bridge.IP_ATTEMPTS.clear()
        bridge.REGISTRY.torrents.clear()
        bridge.REGISTRY.grace = 0
        bridge.REGISTRY.max_viewers = 1
        self.calls = []
        def fake_upstream(data):
            self.calls.append(data)
            if data['action'] == 'rem': return {}
            return {'hash': bridge._lifecycle.torrent_key(data['link']) if data['action'] == 'add' else data.get('hash', 'a'*40), 'file_stats': [{'id': 2, 'path': 'movie.mp4', 'length': 100}], 'download_speed': 1024, 'active_peers': 3}
        bridge.upstream = fake_upstream

    def request(self, method, path, data=None, token=None, origin=bridge.ORIGIN):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        headers = {'Origin': origin, 'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        connection.request(method, path, json.dumps(data or {}), headers)
        response = connection.getresponse()
        body = response.read()
        result = json.loads(body) if body else None
        status, cors = response.status, response.getheader('Access-Control-Allow-Origin')
        connection.close()
        return status, result, cors

    def login(self):
        return self.request('POST', '/session', {})[1]['token']

    def test_cors_and_authentication(self):
        self.assertEqual(self.request('OPTIONS', '/session')[0], 204)
        self.assertEqual(self.request('POST', '/status')[0], 401)
        self.assertEqual(self.request('POST', '/session', {}, origin='https://evil.test')[0], 403)
        self.assertEqual(self.request('POST', '/status', token=self.login())[0], 200)

    def test_torrent_file_selection_and_revocation(self):
        token = self.login()
        status, data, cors = self.request('POST', '/torrent', {'link': 'https://webtorrent.io/torrents/big-buck-bunny.torrent'}, token)
        self.assertEqual(status, 200); self.assertEqual(cors, bridge.ORIGIN)
        self.assertEqual(data['files'][0]['id'], 2)
        self.assertEqual(self.request('POST', '/play', {'index': 1}, token)[0], 400)
        status, data, _ = self.request('POST', '/play', {'index': 2}, token)
        self.assertEqual(status, 200)
        self.assertEqual(self.request('POST', '/stop', token=token)[0], 200)
        self.assertEqual(self.request('GET', data['path'])[0], 401)
        self.assertEqual(self.calls[-1]['action'], 'rem')

    def test_single_active_torrent(self):
        token = self.login()
        link = {'link': 'magnet:?xt=urn:btih:' + 'a' * 40}
        self.assertEqual(self.request('POST', '/torrent', link, token)[0], 200)
        self.assertEqual(self.request('POST', '/torrent', link, token)[0], 409)
        other = self.login()
        self.assertEqual(self.request('POST', '/play', {'index': 2}, other)[0], 409)
        self.assertEqual(self.request('POST', '/stop', token=other)[0], 200)
        self.assertEqual(bridge.SESSIONS[token]['hash'], 'a' * 40)

    def test_session_creation_is_rate_limited(self):
        for _ in range(4):
            self.assertEqual(self.request('POST', '/session')[0], 200)
        self.assertEqual(self.request('POST', '/session')[0], 429)

    def test_reject_unsupported_links(self):
        for link in ('file:///etc/passwd', 'http://example.com/test.torrent', 'https://127.0.0.1/a.torrent', 'magnet:?xt=bad', 'https://user:pass@example.com/a.torrent'):
            self.assertFalse(bridge.valid_link(link))

    def test_shared_viewers_stop_independently(self):
        bridge.REGISTRY.max_viewers = 2
        try:
            first, second = self.login(), self.login()
            link = {'link':'magnet:?xt=urn:btih:'+'a'*40}
            self.assertEqual(self.request('POST','/torrent',link,first)[0],200)
            self.assertEqual(self.request('POST','/torrent',link,second)[0],200)
            self.assertEqual(sum(c['action']=='add' for c in self.calls),1)
            self.request('POST','/stop',token=first)
            self.assertFalse(any(c['action']=='rem' for c in self.calls))
            self.assertEqual(self.request('POST','/play',{'index':2},second)[0],200)
            self.request('POST','/stop',token=second)
            self.assertEqual(sum(c['action']=='rem' for c in self.calls),1)
        finally:
            bridge.REGISTRY.max_viewers = 1

    def test_range_and_disconnect_release_reader(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        response=io.BytesIO(b'video')
        response.status=206
        response.headers={'Content-Type':'video/mp4','Content-Length':'5','Content-Range':'bytes 20-24/100','Accept-Ranges':'bytes'}
        connection=http.client.HTTPConnection(*self.server.server_address,timeout=3)
        with patch.object(bridge.urllib.request,'urlopen',return_value=response) as opening:
            connection.request('GET',path,headers={'Range':'bytes=20-24'})
            result=connection.getresponse()
            self.assertEqual(result.status,206)
            self.assertEqual(result.getheader('Content-Range'),'bytes 20-24/100')
            self.assertEqual(result.read(),b'video')
            self.assertEqual(opening.call_args.args[0].get_header('Range'),'bytes=20-24')
        connection.close()
        # A following control request ensures the handler has had a chance to exit.
        for _ in range(50):
            if bridge.REGISTRY.torrents['a'*40]['readers']==0: break
            time.sleep(.01)
        self.assertEqual(bridge.REGISTRY.torrents['a'*40]['readers'],0)
        self.assertTrue(response.closed)

    def test_invalid_range_does_not_leak_media_slot(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        for _ in range(4):
            connection=http.client.HTTPConnection(*self.server.server_address,timeout=3)
            connection.request('GET',path,headers={'Range':'bytes=0-1,4-5'})
            response=connection.getresponse(); self.assertEqual(response.status,416); response.read(); connection.close()

    def test_audio_rejection_releases_same_media_budget(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        for _ in range(4):
            self.assertEqual(self.request('GET',path+'/audio/999/0')[0],400)

    def test_malformed_json_object_and_rate_limit(self):
        self.assertEqual(self.request('POST','/session',['unexpected'])[0],400)
        token=self.login()
        for _ in range(3): self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        self.assertEqual(self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)[0],429)

    def test_process_escalation_reaps_child(self):
        process=MagicMock()
        process.poll.return_value=None
        process.wait.side_effect=[bridge.subprocess.TimeoutExpired('ffmpeg',1),0]
        bridge.stop_process(process)
        process.terminate.assert_called_once(); process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count,2)

    def test_restart_only_removes_tagged_engine_entries(self):
        with patch.object(bridge,'upstream',side_effect=[[{'hash':'a'*40,'data':bridge._lifecycle.MANAGED},{'hash':'b'*40,'data':'admin'}],{}]) as call:
            bridge.reconcile_startup()
            self.assertEqual(call.call_count,2)
            self.assertEqual(call.call_args.args[0],{'action':'rem','hash':'a'*40})

    def test_upstream_416_is_preserved(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        error=bridge.urllib.error.HTTPError('http://localhost',416,'range',{'Content-Range':'bytes */100'},io.BytesIO())
        with patch.object(bridge.urllib.request,'urlopen',side_effect=error):
            connection=http.client.HTTPConnection(*self.server.server_address,timeout=3)
            connection.request('GET',path,headers={'Range':'bytes=200-'})
            response=connection.getresponse();self.assertEqual(response.status,416)
            self.assertEqual(response.getheader('Content-Range'),'bytes */100');response.read();connection.close()

    def test_media_budget_rejects_without_opening_engine(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        gate=threading.BoundedSemaphore(1);gate.acquire()
        with patch.object(bridge,'MEDIA_GATE',gate),patch.object(bridge.urllib.request,'urlopen') as opening:
            self.assertEqual(self.request('GET',path)[0],503)
            self.assertEqual(self.request('GET',path+'/audio/1/0')[0],503)
            opening.assert_not_called()
            self.assertEqual(self.request('POST','/status',token=token)[0],200)
        gate.release()

    def test_disconnected_client_releases_upstream_and_lease(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        path=self.request('POST','/play',{'index':2},token)[1]['path']
        response=io.BytesIO(b'video');response.status=200;response.headers={}
        handler=object.__new__(bridge.Handler)
        handler.path=path;handler.headers={};handler.send_response=lambda *_:None
        handler.send_header=lambda *_:None;handler.end_headers=lambda:None
        handler.wfile=MagicMock();handler.wfile.write.side_effect=BrokenPipeError()
        with patch.object(bridge.urllib.request,'urlopen',return_value=response):handler.do_GET()
        self.assertTrue(response.closed)
        self.assertEqual(bridge.REGISTRY.torrents['a'*40]['readers'],0)

    def test_stop_racing_play_cannot_issue_new_stream(self):
        token=self.login()
        self.request('POST','/torrent',{'link':'magnet:?xt=urn:btih:'+'a'*40},token)
        engine=bridge.upstream
        def racing(request):
            if request['action']=='get':bridge.REGISTRY.detach(token)
            return engine(request)
        with patch.object(bridge,'upstream',side_effect=racing):
            self.assertEqual(self.request('POST','/play',{'index':2},token)[0],409)
        self.assertEqual(bridge.STREAMS,{})

    def test_delayed_stop_does_not_kill_new_stream(self):
        process=MagicMock();process._dimovie_stream={'cancel':threading.Event()}
        bridge.TRANSCODERS['owner']=process
        try:
            bridge.stop_transcoder('owner')
            process.terminate.assert_not_called()
            self.assertIs(bridge.TRANSCODERS['owner'],process)
        finally:bridge.TRANSCODERS.pop('owner',None)


if __name__ == '__main__':
    unittest.main()
