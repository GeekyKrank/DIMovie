"""Public nickname libraries: deliberately no identity/authentication claim."""
import collections
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORIGIN = 'https://geekykrank.github.io'


def nickname(value):
    if not isinstance(value, str):
        raise ValueError('Введи ник.')
    value = unicodedata.normalize('NFKC', value.strip()).casefold()
    if not 3 <= len(value) <= 32 or not all(c.isalnum() or c in '_-' for c in value):
        raise ValueError('Ник: 3–32 буквы, цифры, дефис или подчёркивание.')
    return value


def movie_record(data):
    if not isinstance(data, dict):
        raise ValueError('Некорректный фильм.')
    anime = data.get('animeId')
    ident = anime if anime is not None else data.get('id')
    if type(ident) is not int or not 0 < ident < 10**9:
        raise ValueError('Некорректный ID.')
    title = data.get('title')
    if not isinstance(title, str) or not 1 <= len(title) <= 200:
        raise ValueError('Некорректное название.')
    poster = data.get('poster_path') or ''
    if not isinstance(poster, str) or len(poster) > 300 or (poster and (not poster.startswith('/') or poster.startswith('//') or '..' in poster or not re.fullmatch(r'/[\w/.-]+', poster))):
        raise ValueError('Некорректная обложка.')
    date = str(data.get('release_date') or '')[:10]
    if date and not re.fullmatch(r'\d{4}(?:-\d{2}-\d{2})?', date):
        raise ValueError('Некорректная дата.')
    rating = data.get('vote_average', 0)
    if not isinstance(rating, (int, float)) or not 0 <= rating <= 10:
        rating = 0
    key = ('anime-' if anime is not None else 'movie-') + str(ident)
    result = dict(id='anime-'+str(ident) if anime is not None else ident, title=title, poster_path=poster, release_date=date, vote_average=rating)
    if anime is not None:
        result['animeId'] = ident
    return key, result


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('CREATE TABLE IF NOT EXISTS profiles (nick TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS movies (nick TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(nick,key));')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        try:
            db.execute('PRAGMA max_page_count=16384')  # approximately 64 MiB
            with db:
                yield db
        finally:
            db.close()

    def apply(self, data):
        nick = nickname(data.get('nick'))
        action = data.get('action', 'get')
        if action not in ('get', 'add', 'remove', 'import'):
            raise ValueError('Неизвестное действие.')
        records = []
        if action in ('add', 'remove'):
            records = [movie_record(data.get('movie'))]
        if action == 'import':
            rows = data.get('movies')
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError('В библиотеке может быть до 100 фильмов.')
            records = [movie_record(row) for row in rows]
        with self.connect() as db:
            if action != 'get':
                db.execute('BEGIN IMMEDIATE')
                if not db.execute('SELECT 1 FROM profiles WHERE nick=?', (nick,)).fetchone():
                    if db.execute('SELECT COUNT(*) FROM profiles').fetchone()[0] >= 1000:
                        raise ValueError('Сервер достиг лимита профилей.')
                    db.execute('INSERT INTO profiles VALUES (?)', (nick,))
                for key, record in records:
                    if action == 'remove':
                        db.execute('DELETE FROM movies WHERE nick=? AND key=?', (nick, key))
                    else:
                        db.execute('INSERT INTO movies VALUES (?,?,?,?) ON CONFLICT(nick,key) DO UPDATE SET data=excluded.data,updated=excluded.updated', (nick, key, json.dumps(record, ensure_ascii=False), time.time_ns()))
                if db.execute('SELECT COUNT(*) FROM movies WHERE nick=?', (nick,)).fetchone()[0] > 100:
                    raise ValueError('В библиотеке может быть до 100 фильмов.')
            rows = db.execute('SELECT data FROM movies WHERE nick=? ORDER BY updated DESC', (nick,)).fetchall()
        return dict(nick=nick, movies=[json.loads(row[0]) for row in rows])


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store):
        self.store = store
        self.gate = threading.BoundedSemaphore(4)
        self.rate_lock = threading.Lock()
        self.ips = collections.OrderedDict()
        self.attempts = collections.deque(maxlen=300)
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.gate.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.gate.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.gate.release()

    def allow(self, ip):
        now = time.monotonic()
        with self.rate_lock:
            recent = self.ips.setdefault(ip, collections.deque(maxlen=60))
            self.ips.move_to_end(ip)
            while len(self.ips) > 256:
                self.ips.popitem(last=False)
            for queue in (recent, self.attempts):
                while queue and queue[0] < now-60:
                    queue.popleft()
            if len(recent) >= 60 or len(self.attempts) >= 300:
                return False
            recent.append(now)
            self.attempts.append(now)
            return True


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass

    def reply(self, code, data=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else b''
        self.send_response(code)
        for name, value in [('Content-Type','application/json'),('Content-Length',str(len(body))),('Access-Control-Allow-Origin',ORIGIN),('Vary','Origin'),('Cache-Control','no-store'),('X-Content-Type-Options','nosniff'),('Access-Control-Allow-Methods','POST, OPTIONS'),('Access-Control-Allow-Headers','Content-Type')]:
            self.send_header(name, value)
        if code == 429:
            self.send_header('Retry-After', '60')
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204)

    def do_POST(self):
        try:
            if self.path != '/library':
                return self.reply(404, {'error':'Неизвестный запрос.'})
            if self.headers.get('Origin') != ORIGIN:
                return self.reply(403, {'error':'Origin запрещён.'})
            if not self.server.allow(self.headers.get('X-Real-IP', self.client_address[0])):
                return self.reply(429, {'error':'Слишком много запросов. Подожди минуту.'})
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                return self.reply(413, {'error':'Слишком большой запрос.'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Некорректный запрос.')
            self.reply(200, self.server.store.apply(data))
        except (ValueError, TypeError, KeyError):
            self.reply(400, {'error':'Проверь ник и данные фильма. Ник: 3–32 буквы, цифры, дефис или подчёркивание; до 100 фильмов.'})
        except sqlite3.Error:
            self.reply(503, {'error':'Хранилище временно недоступно.'})


if __name__ == '__main__':
    directory = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/dimovie-library'))
    Server(('127.0.0.1', 5093), Store(directory/'libraries.sqlite3')).serve_forever()
