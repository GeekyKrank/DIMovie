import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreams, searchSources } from './site/sources.js';
test('Stremio hash, zero-based index, Russian hint, size and seeds', () => {
  const [source] = parseStreams({ streams: [{ infoHash: 'A'.repeat(40), fileIdx: 0, name: 'Torrentio 1080p', title: 'Movie 🇷🇺\n👤 125 💾 1.5 GB', behaviorHints: { filename: 'movie.mp4' } }] });
  assert.equal(source.hash, 'a'.repeat(40)); assert.equal(source.fileIdx, 0);
  assert.equal(source.russian, true); assert.equal(source.seeders, 125);
  assert.equal(source.size, 1.5 * 1024 ** 3); assert.equal(source.filename, 'movie.mp4');
});
test('DRM, special headers, bad hashes and malformed records are excluded', () => {
  const good = { infoHash: 'b'.repeat(40) };
  assert.deepEqual(parseStreams({ streams: [null, 'bad', {...good, drm:{}}, {...good, behaviorHints:{proxyHeaders:{}}}, {...good, externalUrl:'https://example.com'}, {infoHash:'../bad'}] }), []);
});
test('Sources are deduplicated, bounded and Russian hints precede other releases', () => {
  const streams = Array.from({length:90},(_,i)=>({infoHash:i.toString(16).padStart(40,'0'),title:'👤 9'}));
  streams.push({...streams[0]}, {infoHash:'f'.repeat(40),title:'Russian 👤 2'});
  const parsed = parseStreams({streams});
  assert.equal(parsed.length,60); assert.equal(parsed[0].russian,true);
  assert.equal(new Set(parsed.map(s=>s.hash)).size,60);
});
test('Client uses fixed provider, omits credentials and caches fresh results', async () => {
  const original=globalThis.fetch; let count=0;
  globalThis.fetch=async(url,options)=>{
    count++; assert.equal(url,'https://torrentio.strem.fun/stream/movie/tt0000002.json');
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    return new Response(JSON.stringify({streams:[]}),{status:200});
  };
  try {
    await assert.rejects(searchSources('../bad'),/IMDb/);
    const data=await searchSources('tt0000002');
    assert.equal(await searchSources('tt0000002'),data); assert.equal(count,1);
  } finally {globalThis.fetch=original;}
});
