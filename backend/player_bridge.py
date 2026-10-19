"""Bounded guest-session TorrServer bridge for the DIMovie static frontend."""
import collections
import json
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORIGIN = 'https://geekykrank.github.io'
SESSIONS, STREAMS = {}, {}
ATTEMPTS = collections.deque(maxlen=128)
IP_ATTEMPTS = {}
LOCK = threading.Lock()
GATE = threading.BoundedSemaphore(12)
MEDIA_GATE = threading.BoundedSemaphore(3)
PROBE_GATE = threading.BoundedSemaphore(1)
TRANSCODERS = {}

def media_url(stream):
    return 'http://127.0.0.1:8090/stream?' + urllib.parse.urlencode({'link': stream['hash'], 'index': stream['index'], 'play': ''})

def audio_info(stream):
    if not PROBE_GATE.acquire(blocking=False):
        raise ValueError('Проверка дорожек уже выполняется')
    try:
        result = subprocess.run(['/usr/bin/ffprobe', '-v', 'error', '-rw_timeout', '15000000', '-probesize', '8000000', '-analyzeduration', '8000000', '-show_entries', 'format=duration:stream=index,codec_type,codec_name:stream_tags=language,title', '-of', 'json', media_url(stream)], capture_output=True, timeout=40, check=True)
        info = json.loads(result.stdout)
        return {'duration': float(info.get('format', {}).get('duration', 0)), 'tracks': [{'index': s['index'], 'language': s.get('tags', {}).get('language', ''), 'label': s.get('tags', {}).get('title', ''), 'codec': s.get('codec_name', '')} for s in info.get('streams', []) if s.get('codec_type') == 'audio']}
    finally:
        PROBE_GATE.release()


def upstream(data):
    req = urllib.request.Request('http://127.0.0.1:8090/torrents', json.dumps(data).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read(2 * 1024 * 1024) or b'{}')


def valid_link(link):
    if not isinstance(link, str) or len(link) > 4096:
        return False
    parsed = urllib.parse.urlsplit(link)
    if parsed.scheme == 'magnet':
        xt = urllib.parse.parse_qs(parsed.query).get('xt', [''])[0]
        return re.fullmatch(r'urn:btih:(?:[a-fA-F0-9]{40}|[A-Z2-7a-z]{32})', xt) is not None
    # Anonymous clients must not turn the engine into an arbitrary URL fetcher.
    # This one openly licensed demo is permitted for end-to-end smoke tests.
    return link == 'https://webtorrent.io/torrents/big-buck-bunny.torrent'


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def process_request(self, request, address):
        if not GATE.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            GATE.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            GATE.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log passwords, bearer tokens or torrent links.

    def response_headers(self, status, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', ORIGIN)
        self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.response_headers(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.response_headers(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def session(self):
        token = self.headers_in('Authorization').removeprefix('Bearer ')
        with LOCK:
            session = SESSIONS.get(token)
            if session and session['expires'] > time.monotonic():
                session['seen'] = time.monotonic()
                return token, session
        return None, None

    def headers_in(self, name):
        return self.headers.get(name, '')

    def do_POST(self):
        # BaseHTTPRequestHandler stores request headers in self.headers.
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                return self.reply(413, {'error': 'Слишком большой запрос'})
            if self.headers.get('Origin', ORIGIN) != ORIGIN:
                return self.reply(403, {'error': 'Origin запрещён'})
            data = json.loads(self.rfile.read(length))
            if self.path == '/session':
                now = time.monotonic()
                with LOCK:
                    while ATTEMPTS and ATTEMPTS[0] < now - 60:
                        ATTEMPTS.popleft()
                    if len(ATTEMPTS) >= 60:
                        return self.reply(429, {'error': 'Подожди минуту перед следующей попыткой входа'})
                    client_ip = self.headers.get('X-Real-IP', self.client_address[0])
                    for key in list(IP_ATTEMPTS):
                        if IP_ATTEMPTS[key][-1] < now - 60:
                            del IP_ATTEMPTS[key]
                    recent = IP_ATTEMPTS.setdefault(client_ip, collections.deque(maxlen=4))
                    while recent and recent[0] < now - 60:
                        recent.popleft()
                    if len(recent) >= 4:
                        return self.reply(429, {'error': 'Слишком частые подключения. Подожди минуту.'})
                    recent.append(now)
                    ATTEMPTS.append(now)
                    for token in list(SESSIONS):
                        if SESSIONS[token]['expires'] < now:
                            del SESSIONS[token]
                    if len(SESSIONS) >= 64:
                        return self.reply(429, {'error': 'Сервер занят. Попробуй немного позже.'})
                    token = secrets.token_urlsafe(32)
                    SESSIONS[token] = {'expires': now + 6 * 3600, 'seen': now, 'hash': None}
                return self.reply(200, {'token': token})
            token, session = self.session()
            if not session:
                return self.reply(401, {'error': 'Подключись к серверу заново'})
            if self.path == '/torrent':
                if not valid_link(data.get('link')):
                    return self.reply(400, {'error': 'Нужна корректная magnet-ссылка'})
                # Micro serves one active torrent across all client sessions.
                with LOCK:
                    if any(s['hash'] for s in SESSIONS.values()):
                        return self.reply(409, {'error': 'Сервер занят другим зрителем. Попробуй позже.'})
                    session['hash'] = 'pending'
                try:
                    link = data['link']
                    if link.startswith('magnet:'):
                        xt = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)['xt'][0]
                        link = 'magnet:?' + urllib.parse.urlencode({'xt': xt})
                    result = upstream({'action': 'add', 'link': link, 'save_to_db': False})
                    session['hash'] = result['hash']
                except Exception:
                    session['hash'] = None
                    raise
                return self.reply(200, self.describe(session))
            if self.path == '/status':
                return self.reply(200, self.describe(session))
            if self.path == '/audio-info':
                with LOCK:
                    stream = STREAMS.get(data.get('stream', ''))
                if not stream or stream['owner'] != token or stream['expires'] < time.monotonic():
                    return self.reply(401, {'error': 'Ссылка просмотра истекла'})
                info = stream.get('audio') or audio_info(stream)
                stream['audio'] = info
                return self.reply(200, info)
            if self.path == '/play':
                if not session['hash'] or session['hash'] == 'pending':
                    return self.reply(409, {'error': 'Сначала загрузи раздачу в своём сеансе'})
                result = upstream({'action': 'get', 'hash': session['hash']})
                files = result.get('file_stats') or []
                index = int(data.get('index', 0))
                if not any(f['id'] == index for f in files):
                    return self.reply(400, {'error': 'Выбери видеофайл'})
                stream_token = secrets.token_urlsafe(32)
                with LOCK:
                    now = time.monotonic()
                    for old in list(STREAMS):
                        if STREAMS[old]['expires'] < now or STREAMS[old]['owner'] == token:
                            del STREAMS[old]
                    STREAMS[stream_token] = {'hash': session['hash'], 'index': index, 'expires': now + 6 * 3600, 'owner': token}
                return self.reply(200, {'path': '/watch/' + stream_token})
            if self.path == '/stop':
                torrent_hash = session['hash']
                session['hash'] = None
                with LOCK:
                    process = TRANSCODERS.pop(token, None)
                    if process: process.kill()
                    for key in list(STREAMS):
                        if STREAMS[key]['owner'] == token:
                            del STREAMS[key]
                if torrent_hash and torrent_hash != 'pending':
                    upstream({'action': 'rem', 'hash': torrent_hash})
                return self.reply(200, {'stopped': True})
            return self.reply(404, {'error': 'Неизвестный запрос'})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'Некорректный запрос'})
        except (urllib.error.URLError, TimeoutError):
            self.reply(503, {'error': 'Движок не ответил. Попробуй повторить запрос.'})
        except (subprocess.SubprocessError, OSError):
            self.reply(503, {'error': 'Не удалось прочитать звуковые дорожки. Дождись буферизации и повтори.'})

    def describe(self, session):
        if not session['hash'] or session['hash'] == 'pending':
            return {'files': [], 'speed': 0, 'peers': 0}
        result = upstream({'action': 'get', 'hash': session['hash']})
        return {'files': [{'id': f['id'], 'name': f['path'], 'size': f['length']} for f in result.get('file_stats') or []],
                'speed': result.get('download_speed', 0), 'peers': result.get('active_peers', 0)}

    def do_GET(self):
        parts = self.path.removeprefix('/watch/').split('/')
        key = parts[0]
        with LOCK:
            stream = STREAMS.get(key)
        if not self.path.startswith('/watch/') or not stream or stream['expires'] < time.monotonic():
            return self.reply(401, {'error': 'Ссылка просмотра истекла'})
        if len(parts) > 1:
            return self.serve_audio(stream, parts[1:])
        if not MEDIA_GATE.acquire(blocking=False):
            return self.reply(503, {'error': 'Слишком много потоков'})
        response = None
        try:
            query = urllib.parse.urlencode({'link': stream['hash'], 'index': stream['index'], 'play': ''})
            headers = {}
            requested_range = self.headers.get('Range', '')
            if requested_range:
                if not re.fullmatch(r'bytes=(?:\d+-\d*|-\d+)', requested_range):
                    return self.reply(416, {'error': 'Некорректный диапазон'})
                headers['Range'] = requested_range
            response = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8090/stream?' + query, headers=headers), timeout=90)
            self.send_response(response.status)
            for header in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'):
                if response.headers.get(header):
                    self.send_header(header, response.headers[header])
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            while chunk := response.read(64 * 1024):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except urllib.error.URLError:
            if response is None:
                self.reply(503, {'error': 'Недостаточно данных для воспроизведения'})
        finally:
            if response:
                response.close()
            MEDIA_GATE.release()

    def serve_audio(self, stream, parts):
        if len(parts) != 3 or parts[0] != 'audio' or not re.fullmatch(r'\d{1,4}', parts[1]) or not re.fullmatch(r'\d{1,6}(?:\.\d{1,3})?', parts[2]):
            return self.reply(400, {'error': 'Некорректная дорожка'})
        info = stream.get('audio')
        index, start = int(parts[1]), float(parts[2])
        if not info or index not in [t['index'] for t in info['tracks']] or start > max(info['duration'], 0):
            return self.reply(400, {'error': 'Дорожка не найдена'})
        process = None
        try:
            with LOCK:
                previous = TRANSCODERS.pop(stream['owner'], None)
                if previous: previous.kill()
                if TRANSCODERS:
                    return self.reply(503, {'error': 'Обработка звука занята'})
                process = subprocess.Popen(['/usr/bin/ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-rw_timeout', '15000000', '-ss', str(start), '-i', media_url(stream), '-map', '0:v:0', '-map', '0:' + str(index), '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-threads', '1', '-avoid_negative_ts', 'make_zero', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                TRANSCODERS[stream['owner']] = process
            self.connection.settimeout(30)
            first = process.stdout.read(4096)
            if not first:
                return self.reply(503, {'error': 'Кодек файла не поддерживается'})
            self.response_headers(200, 'video/mp4')
            self.send_header('Connection', 'close'); self.end_headers()
            self.close_connection = True
            self.wfile.write(first)
            while chunk := process.stdout.read(64 * 1024): self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            if process:
                process.kill() if process.poll() is None else None
                process.wait(timeout=5)
                process.stdout.close()
                with LOCK:
                    if TRANSCODERS.get(stream['owner']) is process: TRANSCODERS.pop(stream['owner'], None)


def cleanup():
    while True:
        time.sleep(30)
        stale_hashes = []
        with LOCK:
            now = time.monotonic()
            for token in list(SESSIONS):
                session = SESSIONS[token]
                if session['expires'] < now or session['seen'] < now - 300:
                    process = TRANSCODERS.pop(token, None)
                    if process: process.kill()
                    if session['hash'] and session['hash'] != 'pending':
                        stale_hashes.append(session['hash'])
                    del SESSIONS[token]
            for key in list(STREAMS):
                if STREAMS[key]['owner'] not in SESSIONS or STREAMS[key]['expires'] < now:
                    del STREAMS[key]
        for torrent_hash in stale_hashes:
            try:
                upstream({'action': 'rem', 'hash': torrent_hash})
            except (urllib.error.URLError, ValueError, TimeoutError):
                pass


if __name__ == '__main__':
    threading.Thread(target=cleanup, daemon=True).start()
    Server(('127.0.0.1', 5091), Handler).serve_forever()
