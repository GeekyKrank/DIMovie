"""Small, synchronous lease registry; the engine and HTTP API stay unchanged."""
import base64
import threading
import time

MANAGED = 'dimovie-managed-v1'


class Busy(Exception):
    pass


def torrent_key(link):
    from urllib.parse import urlsplit, parse_qs
    if link.startswith('magnet:'):
        value = parse_qs(urlsplit(link).query)['xt'][0].split(':')[-1]
        return value.lower() if len(value) == 40 else base64.b32decode(value.upper()).hex()
    return 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'


class Registry:
    def __init__(self, sessions, streams, engine, max_viewers=1, max_torrents=1, grace=60, clock=time.monotonic):
        self.sessions, self.streams, self.engine = sessions, streams, engine
        self.max_viewers, self.max_torrents, self.grace, self.clock = max_viewers, max_torrents, grace, clock
        self.lock = threading.RLock()
        self.torrents = {}

    def attach(self, token, link):
        key = torrent_key(link)
        # Evict unused OTHER torrents before admitting another one. No active
        # owner or open reader can be removed to make room.
        self.reap(except_key=key)
        with self.lock:
            session = self.sessions.get(token)
            if not session or session.get('hash') or session['expires'] <= self.clock():
                raise Busy('Сеанс изменился. Повтори выбор источника.')
            if sum(bool(s.get('hash')) for s in self.sessions.values()) >= self.max_viewers:
                raise Busy('Сервер занят другим зрителем. Попробуй позже.')
            entry = self.torrents.get(key)
            if entry and entry['state'] in ('removing', 'failed'):
                raise Busy('Предыдущий буфер очищается. Повтори через несколько секунд.')
            creator = entry is None
            if creator:
                if len(self.torrents) >= self.max_torrents:
                    raise Busy('Достигнут лимит активных раздач.')
                entry = dict(state='adding', owners=set(), readers=0, ready=threading.Event(), last=self.clock())
                self.torrents[key] = entry
            ticket = object()
            session.update(hash=key, ticket=ticket)
            entry['owners'].add(token)
        try:
            if creator:
                try:
                    clean_link = 'magnet:?xt=urn:btih:' + key if link.startswith('magnet:') else link
                    result = self.engine({'action': 'add', 'link': clean_link, 'save_to_db': False, 'data': MANAGED})
                    if result['hash'].lower() != key:
                        raise ValueError('Unexpected engine hash')
                    with self.lock:
                        entry['state'] = 'ready'
                except Exception:
                    with self.lock:
                        entry['state'] = 'failed'
                    raise
                finally:
                    entry['ready'].set()
            elif not entry['ready'].wait(25):
                raise Busy('Раздача ещё подключается. Повтори позже.')
            with self.lock:
                if self.sessions.get(token) is not session or session.get('ticket') is not ticket or entry['state'] != 'ready':
                    raise Busy('Загрузка отменена или завершилась ошибкой.')
                return key
        except Exception:
            with self.lock:
                entry['owners'].discard(token)
                entry['last'] = self.clock()
                if session.get('ticket') is ticket:
                    session.update(hash=None, ticket=None)
            self.reap(force_failed=True)
            raise

    def detach(self, token, delete=False):
        with self.lock:
            session = self.sessions.get(token)
            if not session:
                return
            key = session.get('hash')
            session.update(hash=None, ticket=None)
            entry = self.torrents.get(key)
            if entry:
                entry['owners'].discard(token)
                entry['last'] = self.clock()
            for stream_key, stream in list(self.streams.items()):
                if stream['owner'] == token:
                    stream['cancel'].set()
                    del self.streams[stream_key]
            if delete:
                self.sessions.pop(token, None)

    def acquire(self, stream_key):
        with self.lock:
            stream = self.streams.get(stream_key)
            if not stream or stream['expires'] <= self.clock() or stream['cancel'].is_set():
                return None
            session = self.sessions.get(stream['owner'])
            entry = self.torrents.get(stream['hash'])
            if not session or session['expires'] <= self.clock() or not entry or entry['state'] != 'ready':
                return None
            session['seen'] = self.clock()
            session['readers'] = session.get('readers', 0) + 1
            entry['readers'] += 1
            return stream

    def release(self, stream):
        with self.lock:
            entry = self.torrents.get(stream['hash'])
            if entry:
                entry['readers'] = max(0, entry['readers'] - 1)
                entry['last'] = self.clock()
            session = self.sessions.get(stream['owner'])
            if session:
                session['readers'] = max(0, session.get('readers', 0) - 1)
                session['seen'] = self.clock()

    def alive(self, stream):
        with self.lock:
            session = self.sessions.get(stream['owner'])
            if stream['cancel'].is_set() or stream['expires'] <= self.clock() or not session or session['expires'] <= self.clock():
                return False
            session['seen'] = self.clock()
            return True

    def reap(self, except_key=None, force_failed=False):
        with self.lock:
            candidates = []
            for key, entry in self.torrents.items():
                if entry['owners'] or entry['readers'] or entry['state'] in ('adding', 'removing'):
                    continue
                if (except_key is not None and key != except_key) or (force_failed and entry['state'] == 'failed') or self.clock() - entry['last'] >= self.grace:
                    entry['state'] = 'removing'
                    candidates.append((key, entry))
        for key, entry in candidates:
            try:
                self.engine({'action': 'rem', 'hash': key})
            except Exception:
                with self.lock:
                    entry.update(state='failed', last=self.clock())
            else:
                with self.lock:
                    if self.torrents.get(key) is entry:
                        del self.torrents[key]

    def expired(self):
        with self.lock:
            now = self.clock()
            return [token for token, s in self.sessions.items() if s['expires'] <= now or (not s.get('readers') and s['seen'] < now - 300)]
