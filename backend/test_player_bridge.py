import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest

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
        self.calls = []
        def fake_upstream(data):
            self.calls.append(data)
            if data['action'] == 'rem': return {}
            return {'hash': 'a' * 40, 'file_stats': [{'id': 2, 'path': 'movie.mp4', 'length': 100}], 'download_speed': 1024, 'active_peers': 3}
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


if __name__ == '__main__':
    unittest.main()
