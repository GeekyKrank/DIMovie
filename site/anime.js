const ORIGIN = 'https://anilibria.top';
const cache = new Map();
export function animeImage(path) {
  return typeof path === 'string' && path.startsWith('/storage/') && !path.includes('..') ? ORIGIN + path : '';
}
export function animeStream(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'cache.libria.fun' && !parsed.username && !parsed.password && parsed.pathname.endsWith('.m3u8') ? parsed.href : '';
  } catch { return ''; }
}
async function request(path, signal) {
  signal?.throwIfAborted();
  const saved = cache.get(path);
  if (saved?.expires > Date.now()) return saved.data;
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const response = await fetch(ORIGIN + '/api/v1' + path, {signal:combined, credentials:'omit', redirect:'error'});
  if (!response.ok) throw new Error(`Каталог аниме недоступен (HTTP ${response.status}).`);
  const reader = response.body.getReader(); const chunks=[]; let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>4*1024*1024) {await reader.cancel();throw new Error('Слишком большой ответ каталога аниме.');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const buffer=new Uint8Array(size);let offset=0;
  for (const chunk of chunks) {buffer.set(chunk,offset);offset+=chunk.length;}
  const data=JSON.parse(new TextDecoder().decode(buffer));
  if (cache.size>=16) cache.delete(cache.keys().next().value);
  cache.set(path,{data,expires:Date.now()+120000});return data;
}
export function animeCard(row) {
  return {animeId:row.id,id:'anime-'+row.id,title:row.name?.main || row.name?.english || 'Аниме',poster_path:row.poster?.optimized?.preview || row.poster?.preview,release_date:String(row.year || ''),vote_average:Number(row.mal?.rating || row.shikimori?.rating || 0)};
}
export async function animeCatalog(query, page, signal) {
  const params=new URLSearchParams({page:String(page),limit:'21','f[sorting]':'RATING_DESC',...(query?{'f[search]':query.slice(0,180)}:{})});
  const data=await request('/anime/catalog/releases?'+params,signal);
  if (!Array.isArray(data.data)) throw new Error('Некорректный ответ каталога аниме.');
  return {results:data.data.map(animeCard),total_pages:Number(data.meta?.pagination?.total_pages || 1)};
}
export async function animeRelease(id, signal) {
  if (!Number.isSafeInteger(id) || id<1) throw new Error('Некорректный ID аниме.');
  const data=await request('/anime/releases/'+id,signal);
  if (data.id!==id || !Array.isArray(data.episodes)) throw new Error('Не удалось получить серии.');
  return data;
}
export function playableEpisodes(release) {
  if (release.is_blocked_by_geo || release.is_blocked_by_copyrights) return [];
  return (release.episodes || []).slice(0,2000).map(episode=>({
    ordinal:episode.ordinal,name:episode.name || '',
    qualities:[1080,720,480].map(quality=>({quality,url:animeStream(episode['hls_'+quality])})).filter(item=>item.url)
  })).filter(episode=>episode.qualities.length).sort((a,b)=>a.ordinal-b.ordinal);
}
export async function findAnimeMovie(title, year, signal) {
  const data=await request('/app/search/releases?'+new URLSearchParams({query:title.slice(0,180)}),signal);
  if (!Array.isArray(data)) return null;
  const normalize=text=>String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const wanted=normalize(title);
  return data.find(row=>[row.name?.main,row.name?.english,row.name?.alternative].some(name=>normalize(name).includes(wanted)) && row.type?.value==='MOVIE' && String(row.year)===String(year) && !row.is_blocked_by_geo && !row.is_blocked_by_copyrights) || null;
}
