import { API_BASE } from './config.js';
const cache = new Map();
export async function api(path, params = {}, signal) {
  const url = new URL(path, API_BASE);
  url.search = new URLSearchParams({ language: 'ru', ...params });
  const key = url.href;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.data;
  let response;
  try { response = await fetch(key, { signal, credentials: 'omit' }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Не удалось подключиться к каталогу. Проверь интернет и повтори попытку.');
  }
  if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много запросов. Подожди немного.' : 'Каталог временно недоступен. Попробуй ещё раз.');
  const data = await response.json();
  if (cache.size >= 30) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + 300_000 });
  return data;
}
export function posterUrl(path, size = 'w342') {
  return typeof path === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}
