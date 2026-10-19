import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreams, searchSources, mergeSources, sortSources, matchMovieSources, SOURCE_PROVIDERS } from './site/sources.js';
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

test('Ukrainian audio hints support flags, names and language codes without confusing UK releases', () => {
  for (const title of ['Movie 🇺🇦', 'Movie UKR', 'Українська озвучка', 'Украинский дубляж', 'Movie / укр /']) {
    assert.equal(parseStreams({streams:[{infoHash:'a'.repeat(40),title}]} )[0].ukrainian, true, title);
  }
  for (const language of ['uk', 'uk-UA', 'ukr', 'Ukrainian']) {
    assert.equal(parseStreams({streams:[{infoHash:'a'.repeat(40),audioLanguages:[language]}]})[0].ukrainian,true);
  }
  const [both] = parseStreams({streams:[{infoHash:'a'.repeat(40),title:'🇷🇺 🇺🇦'}]});
  assert.equal(both.russian && both.ukrainian,true);
  assert.equal(parseStreams({streams:[{infoHash:'a'.repeat(40),title:'Movie UK English'}]})[0].ukrainian,false);
});
test('Sources are deduplicated, bounded and Russian hints precede other releases', () => {
  const streams = Array.from({length:90},(_,i)=>({infoHash:i.toString(16).padStart(40,'0'),title:'👤 9'}));
  streams.push({...streams[0]}, {infoHash:'f'.repeat(40),title:'Russian 👤 2'});
  const parsed = parseStreams({streams});
  assert.equal(parsed.length,60); assert.equal(parsed[0].russian,true);
  assert.equal(new Set(parsed.map(s=>s.hash)).size,60);
});
test('Client uses fixed providers, omits credentials and caches fresh results', async () => {
  const original=globalThis.fetch; let count=0;
  globalThis.fetch=async(url,options)=>{
    count++; assert.ok(SOURCE_PROVIDERS.some(p => url === p.base + '/stream/movie/tt0000002.json'));
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    return new Response(JSON.stringify({streams:[]}),{status:200});
  };
  try {
    await assert.rejects(searchSources('../bad'),/IMDb/);
    const data=await searchSources('tt0000002');
    assert.equal(await searchSources('tt0000002'),data); assert.equal(count,4);
  } finally {globalThis.fetch=original;}
});

test('Merging providers deduplicates file hashes and combines language hints', () => {
  const stream={hash:'a'.repeat(40),fileIdx:0,russian:false,ukrainian:true,seeders:1};
  const merged=mergeSources([{provider:'one',streams:[stream]},{provider:'two',streams:[{...stream,russian:true,ukrainian:false,seeders:5},{...stream,fileIdx:1}]}]);
  assert.equal(merged.length,2);assert.equal(merged[0].russian,true);assert.equal(merged[0].ukrainian,true);
  assert.deepEqual(merged[0].providers,['one','two']);assert.equal(merged[0].seeders,5);
  assert.equal(stream.russian,false);
});
test('Provider failure leaves healthy streams available and reports missing providers', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async url => {
    if (!url.startsWith('https://mediafusion.elfhosted.com/')) throw new Error('offline');
    return new Response(JSON.stringify({streams:[{infoHash:'c'.repeat(40),name:'MediaFusion',audioLanguages:['ru']}]}));
  };
  try {const data=await searchSources('tt0000003');assert.equal(data.streams.length,1);assert.equal(data.unavailable.length,3);assert.equal(data.streams[0].russian,true);}
  finally {globalThis.fetch=original;}
});
test('All providers unavailable fails clearly and cancelled searches do not return cached data', async () => {
  const original=globalThis.fetch;globalThis.fetch=async()=>new Response('',{status:503});
  try {
    await assert.rejects(searchSources('tt0000004'),/недоступны/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(searchSources('tt0000002',controller.signal),{name:'AbortError'});
  } finally {globalThis.fetch=original;}
});

test('Source sorting orders quality, audio and peers without mutating original or promoting unknowns', () => {
  const rows=[{quality:'720p',seeders:20,russian:true},{quality:'2160p',seeders:3,ukrainian:true},{quality:'',seeders:null}];
  assert.equal(sortSources(rows,'quality')[0],rows[1]);
  assert.equal(sortSources(rows,'quality',true)[0],rows[0]);
  assert.equal(sortSources(rows,'peers')[0],rows[0]);
  assert.equal(sortSources(rows,'peers',true)[2],rows[2]);
  assert.equal(sortSources(rows,'language',false,'uk')[0],rows[1]);
  assert.equal(sortSources(rows,'language')[0],rows[0]);
  assert.equal(rows[0].quality,'720p');
});

test('Movie matching excludes unrelated episodes, remakes and puts zero-seed sources last', () => {
 const rows=[{title:'Futurama Season 6 Ghost in the Machines 2012',seeders:28},{title:'Призрак в доспехах / Ghost in the Shell 1995',seeders:0},{title:'Ghost.in.the.Shell.1995.1080p',seeders:509},{title:'Ghost in the Shell 2017',seeders:800}];
 const result=matchMovieSources(rows,{title:'Призрак в доспехах',originalTitle:'Ghost in the Shell',year:'1995'});
 assert.deepEqual(result,[rows[2],rows[1]]);
 assert.equal(rows[0].seeders,28);
});
