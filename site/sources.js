// Standard Stremio client request from the visitor's device, just like the app.
const cache = new Map();
export function parseStreams(payload) {
  if (!payload || payload.error || !Array.isArray(payload.streams)) throw new Error('Дополнение вернуло некорректный ответ.');
  const result = [], seen = new Set();
  for (const item of payload.streams.slice(0, 600)) {
    if (!item || typeof item !== 'object' || 'drm' in item || 'drmInfo' in item || item.externalUrl) continue;
    const hints = item.behaviorHints || {};
    if (typeof hints !== 'object' || 'proxyHeaders' in hints || !/^[a-f\d]{40}$/i.test(item.infoHash || '')) continue;
    const hash = item.infoHash.toLowerCase();
    const fileIdx = Number.isInteger(item.fileIdx) && item.fileIdx >= 0 && item.fileIdx < 10000 ? item.fileIdx : null;
    const key = `${hash}:${fileIdx}`; if (seen.has(key)) continue; seen.add(key);
    const name = String(item.name || 'Torrentio').slice(0, 100);
    const title = String(item.description || item.title || name).slice(0, 1200);
    const text = `${name}\n${title}`;
    const sizeMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(GiB|GB|ГБ|MiB|MB|МБ)/i);
    const size = Number.isFinite(hints.videoSize) && hints.videoSize > 0 ? hints.videoSize : sizeMatch ? Math.round(Number(sizeMatch[1].replace(',', '.')) * (/(gib|gb|гб)/i.test(sizeMatch[2]) ? 1024 ** 3 : 1024 ** 2)) : null;
    const seeds = title.match(/(?:👤|👥|seeders?\s*[:=]?)\s*(\d+)/i);
    result.push({ name, title, hash, fileIdx, size, seeders: seeds ? Number(seeds[1]) : null,
      russian: /\b(?:rus|russian|russia|ru)\b|русск|🇷🇺/i.test(text) || (Array.isArray(item.audioLanguages) && item.audioLanguages.some(v => /^(ru|rus|russian)$/i.test(v))),
      ukrainian: /\b(?:ukr|ukrainian)\b|україн|украин|(?:^|[\s,;/+])укр(?:$|[\s,;/+])|🇺🇦/i.test(text) || (Array.isArray(item.audioLanguages) && item.audioLanguages.some(v => /^(?:uk(?:[-_]UA)?|ukr|ukrainian)$/i.test(v))),
      quality: text.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1] || '',
      filename: String(hints.filename || '').slice(0, 500), codecWarning: /\b(hevc|x265|h265|dts|truehd)\b/i.test(text) });
  }
  return result.sort((a, b) => Number(b.russian) - Number(a.russian) || (b.seeders || 0) - (a.seeders || 0)).slice(0, 60);
}
export const SOURCE_PROVIDERS = Object.freeze([
  { name: 'Torrentio', base: 'https://torrentio.strem.fun' },
  { name: 'RuTracker / Rutor · Torrentio', base: 'https://torrentio.strem.fun/providers=rutracker,rutor' },
  { name: 'Nyaa / аниме · Torrentio', base: 'https://torrentio.strem.fun/providers=nyaasi,tokyotosho,anidex' },
  { name: 'MediaFusion', base: 'https://mediafusion.elfhosted.com' }
]);
export function mergeSources(groups) {
  const seen = new Map();
  for (const group of groups) for (const stream of group.streams) {
    const key = `${stream.hash}:${stream.fileIdx}`;
    const previous = seen.get(key);
    if (previous) {
      previous.russian ||= stream.russian; previous.ukrainian ||= stream.ukrainian;
      previous.size ||= stream.size;
      if (stream.seeders !== null) previous.seeders = Math.max(previous.seeders || 0, stream.seeders);
      if (!previous.providers.includes(group.provider)) previous.providers.push(group.provider);
    } else seen.set(key, { ...stream, providers: [group.provider] });
  }
  return [...seen.values()].sort((a, b) => Number(b.russian) - Number(a.russian) || (b.seeders || 0) - (a.seeders || 0)).slice(0, 120);
}
async function requestProvider(provider, imdb, signal) {
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${provider.base}/stream/movie/${imdb}.json`, { signal: combined, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Слишком большой ответ дополнения.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new Error('Дополнение вернуло некорректный JSON.'); }
  const streams = parseStreams(payload);
  for (const stream of streams) if (stream.name === 'Torrentio' && provider.name === 'MediaFusion') stream.name = 'MediaFusion';
  return { streams, provider: provider.name };
}
export async function searchSources(imdb, signal) {
  if (!/^tt\d{5,12}$/.test(imdb)) throw new Error('У фильма нет корректного IMDb ID.');
  signal?.throwIfAborted();
  const saved = cache.get(imdb);
  if (saved?.expires > Date.now()) return saved.data;
  const results = await Promise.allSettled(SOURCE_PROVIDERS.map(provider => requestProvider(provider, imdb, signal)));
  signal?.throwIfAborted();
  const groups = [], unavailable = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') groups.push(result.value);
    else unavailable.push(SOURCE_PROVIDERS[index].name);
  });
  if (!groups.length) throw new Error('Источники недоступны с твоего устройства. Проверь подключение или повтори поиск позже.');
  const data = { streams: mergeSources(groups), provider: groups.map(group => group.provider).join(' · '), unavailable };
  // A partial failure should recover promptly instead of persisting for five minutes.
  if (cache.size >= 12) cache.delete(cache.keys().next().value);
  cache.set(imdb, { data, expires: Date.now() + (unavailable.length ? 30_000 : 300_000) });
  return data;
}
