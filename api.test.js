import test from 'node:test';
import assert from 'node:assert/strict';
import { api, posterUrl } from './site/api.js';
test('poster URLs accept TMDB paths only', () => {
  assert.equal(posterUrl('/poster.jpg'), 'https://image.tmdb.org/t/p/w342/poster.jpg');
  assert.equal(posterUrl('https://evil.test/x'), '');
  assert.equal(posterUrl('/../x'), '');
  assert.equal(posterUrl(null), '');
});
test('fresh cached metadata avoids a second request and carries no credentials', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(options.credentials, 'omit');
    assert.match(url, /language=ru/);
    return { ok: true, json: async () => ({ results: [{ id: 1 }] }) };
  };
  try {
    const first = await api('movie/popular', { page: 1 });
    assert.equal(await api('movie/popular', { page: 1 }), first);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('upstream failure remains an error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try { await assert.rejects(api('movie/top_rated'), /Слишком много/); }
  finally { globalThis.fetch = original; }
});
