import { api, posterUrl } from './api.js';
import { openPlayer, stopPlayer } from './player.js?v=audio-menu-1';
const $ = id => document.getElementById(id);
const state = { category: 'movie/popular', query: '', page: 1, pages: 1, library: false };
let controller, detailController, searchTimer, selectedMovie = null, catalogueScroll = 0;
let favorites = readFavorites();
function readFavorites() {
  try {
    const items = JSON.parse(localStorage.getItem('dimovie-favorites') || '[]');
    return Array.isArray(items) ? items.filter(m => Number.isInteger(m.id) && typeof m.title === 'string').slice(0, 100) : [];
  } catch { return []; }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function image(path, size, className) {
  const src = posterUrl(path, size);
  if (!src) return el('div', className);
  const img = el('img', className);
  img.src = src; img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}
function card(movie) {
  const node = el('button', 'card'); node.type = 'button';
  node.setAttribute('aria-label', movie.title);
  const poster = el('div', 'poster'); poster.append(image(movie.poster_path, 'w342'));
  if (movie.vote_average > 0) poster.append(el('span', 'rating', `★ ${movie.vote_average.toFixed(1)}`));
  node.append(poster, el('h3', '', movie.title), el('span', 'year', (movie.release_date || '').slice(0, 4) || 'Дата не указана'));
  node.addEventListener('click', () => openMovie(movie)); return node;
}
function skeletons() {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 12; i++) { const node = el('div', 'skeleton'); node.setAttribute('aria-hidden', 'true'); node.append(el('div', 'poster'), el('h3')); fragment.append(node); }
  $('grid').replaceChildren(fragment);
}
async function load() {
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  $('retry').hidden = true; $('previous').disabled = true; $('next').disabled = true;
  $('pagination').hidden = state.library;
  $('catalog-tab').classList.toggle('active', !state.library); $('library-tab').classList.toggle('active', state.library);
  $('catalog-tab').setAttribute('aria-pressed', String(!state.library)); $('library-tab').setAttribute('aria-pressed', String(state.library));
  $('categories').hidden = state.library || !!state.query;
  $('status').textContent = '';
  if (state.library) {
    const list = favorites.filter(m => m.title.toLocaleLowerCase('ru').includes(state.query.toLocaleLowerCase('ru')));
    $('grid').replaceChildren(...list.map(card));
    if (!list.length) $('status').textContent = 'Здесь появятся сохранённые фильмы. Добавь их в избранное на странице фильма.';
    return;
  }
  skeletons(); $('grid').setAttribute('aria-busy', 'true');
  try {
    const data = await api(state.query ? 'search/movie' : state.category, { page: state.page, ...(state.query ? { query: state.query } : {}) }, signal);
    if (signal.aborted) return;
    state.pages = Math.min(data.total_pages || 1, 500);
    $('grid').replaceChildren(...(data.results || []).map(card));
    if (!data.results?.length) $('status').textContent = 'Ничего не найдено. Попробуй другое название.';
    $('previous').disabled = state.page <= 1; $('next').disabled = state.page >= state.pages;
  } catch (error) {
    if (signal.aborted) return;
    $('grid').replaceChildren(); $('status').textContent = error.message; $('retry').hidden = false;
  } finally { if (!signal.aborted) $('grid').removeAttribute('aria-busy'); }
}
async function openMovie(movie) {
  if (selectedMovie?.id !== movie.id) await stopPlayer();
  catalogueScroll = window.scrollY;
  selectedMovie = movie;
  $('catalog-page').hidden = true; $('watch-page').hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
  detailController?.abort(); detailController = new AbortController();
  const signal = detailController.signal;
  const content = $('movie-content'); content.replaceChildren(el('p', 'detail-body', 'Загружаем фильм…'));
  try {
    const details = await api(`movie/${movie.id}`, { append_to_response: 'external_ids' }, signal);
    if (signal.aborted) return;
    const body = el('div', 'detail-body'); const title = el('h1', '', details.title); title.id = 'movie-title';
    const meta = el('div', 'metadata');
    [details.vote_average > 0 ? `★ ${details.vote_average.toFixed(1)}` : '', (details.release_date || '').slice(0, 4), details.runtime ? `${details.runtime} мин` : '', 'Фильм'].filter(Boolean).forEach(text => meta.append(el('span', '', text)));
    const genres = el('div', 'genres', (details.genres || []).map(g => g.name).join(' · '));
    const actions = el('div', 'actions');
    const favorite = el('button', 'primary');
    const updateFavorite = () => { const saved = favorites.some(m => m.id === movie.id); favorite.textContent = saved ? 'Убрать из избранного' : '+ В избранное'; favorite.setAttribute('aria-pressed', String(saved)); };
    updateFavorite();
    favorite.addEventListener('click', () => {
      const exists = favorites.some(m => m.id === movie.id);
      const next = exists ? favorites.filter(m => m.id !== movie.id) : [{ id: details.id, title: details.title, poster_path: details.poster_path, release_date: details.release_date, vote_average: details.vote_average }, ...favorites].slice(0, 100);
      try { localStorage.setItem('dimovie-favorites', JSON.stringify(next)); favorites = next; updateFavorite(); if (state.library) load(); }
      catch { note.textContent = 'Браузер не разрешил сохранить избранное. Проверь доступ к хранилищу.'; }
    });
    const player = el('button', 'secondary', '▶ Смотреть онлайн'); player.addEventListener('click', () => $('inline-player').scrollIntoView({ block: 'start' }));
    actions.append(favorite, player);
    const note = el('p', 'note');
    body.append(title, meta, genres, el('p', 'overview', details.overview || 'Описание пока не добавлено.'), actions, note);
    content.replaceChildren(image(details.poster_path, 'w342', 'movie-poster'), body);
    openPlayer(details.title, posterUrl(details.backdrop_path, 'w1280'), details.external_ids?.imdb_id || details.imdb_id || '');
    document.title = `${details.title} — DIMovie`;
  } catch (error) { if (!signal.aborted) content.replaceChildren(el('p', 'detail-body', error.message)); }
}
async function showCatalogue() {
  detailController?.abort();
  $('watch-page').hidden = true; $('catalog-page').hidden = false;
  document.title = 'DIMovie — фильмы';
  window.scrollTo({ top: catalogueScroll, behavior: 'instant' });
  await stopPlayer();
}
$('back-catalog').addEventListener('click', showCatalogue);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer); controller?.abort();
  searchTimer = setTimeout(() => { state.query = $('search').value.trim(); state.page = 1; load(); }, 350);
  if (!$('watch-page').hidden) showCatalogue();
});
document.querySelectorAll('.chip').forEach(button => button.addEventListener('click', () => {
  clearTimeout(searchTimer); if (!$('watch-page').hidden) showCatalogue(); state.category = button.dataset.category; state.page = 1; state.query = ''; $('search').value = '';
  document.querySelectorAll('.chip').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); load();
}));
for (const [id, library] of [['catalog-tab', false], ['library-tab', true]]) $(id).addEventListener('click', () => { clearTimeout(searchTimer); showCatalogue(); state.library = library; state.page = 1; state.query = ''; $('search').value = ''; load(); });
for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => { state.page += delta; load(); window.scrollTo({ top: 0, behavior: 'instant' }); });
$('retry').addEventListener('click', load);
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); $('search').focus(); } });
load();
