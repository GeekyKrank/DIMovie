import test from 'node:test';
import assert from 'node:assert/strict';
import {animeStream,animeImage,playableEpisodes,animeCatalog,animeRelease,findAnimeMovie} from './site/anime.js';

test('Anime streams preserve provider parameters and reject arbitrary URLs',()=>{
  const url='https://cache.libria.fun/episode.m3u8?isWithVideoAds=1&countryIso=UA';
  assert.equal(animeStream(url),url);
  for(const bad of ['http://cache.libria.fun/a.m3u8','https://evil.test/a.m3u8','https://x:pass@cache.libria.fun/a.m3u8','javascript:alert(1)'])assert.equal(animeStream(bad),'');
  assert.equal(animeImage('/storage/poster.jpg'),'https://anilibria.top/storage/poster.jpg');
  assert.equal(animeImage('//evil.test/poster.jpg'),'');
});
test('Episodes are ordered and provider geo/copyright restrictions are respected',()=>{
  const release={episodes:[{ordinal:2,hls_720:'https://cache.libria.fun/two.m3u8'},{ordinal:1,hls_480:'https://cache.libria.fun/one.m3u8'},{ordinal:3,hls_720:'https://evil.test/video.m3u8'}]};
  assert.deepEqual(playableEpisodes(release).map(e=>e.ordinal),[1,2]);
  assert.deepEqual(playableEpisodes({...release,is_blocked_by_geo:true}),[]);
  assert.deepEqual(playableEpisodes({...release,is_blocked_by_copyrights:true}),[]);
});
test('Anime API caches bounded catalog metadata, validates release IDs and exact movie year',async()=>{
  const original=globalThis.fetch;let count=0;
  globalThis.fetch=async(url,options)=>{
    count++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    if(url.includes('/app/search/'))return new Response(JSON.stringify([{id:1,name:{main:'Призрак в доспехах'},type:{value:'TV'},year:1995},{id:2,name:{main:'Призрак в доспехах'},type:{value:'MOVIE'},year:2017},{id:9716,name:{main:'Призрак в доспехах (1995)'},type:{value:'MOVIE'},year:1995}]));
    return new Response(JSON.stringify({data:[{id:9716,name:{main:'Призрак в доспехах'},year:1995}],meta:{pagination:{total_pages:91}}}));
  };
  try{
    const data=await animeCatalog('test',1);assert.equal(data.results[0].animeId,9716);assert.equal(data.total_pages,91);
    await animeCatalog('test',1);assert.equal(count,1);
    await assert.rejects(animeRelease('../secret'),/ID/);
    assert.equal((await findAnimeMovie('Призрак в доспехах','1995')).id,9716);
    const controller=new AbortController();controller.abort();await assert.rejects(animeCatalog('test',1,controller.signal),{name:'AbortError'});
  }finally{globalThis.fetch=original;}
});
