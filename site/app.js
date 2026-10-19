import { normalizeNick, profileLibrary } from './profile.js?v=profiles-1';
import { animeCatalog, animeRelease, animeImage, animeCard, playableEpisodes, findAnimeMovie } from './anime.js?v=anime-1';
import { api, posterUrl } from './api.js';
import { openPlayer, stopPlayer, setupAnimePlayer, startAnimeStream } from './player.js?v=anime-bar-1';
const $ = id => document.getElementById(id);
const state = { category: 'movie/popular', query: '', page: 1, pages: 1, library: false, anime: false };
let controller, detailController, searchTimer, selectedMovie = null, catalogueScroll = 0;
let profileNick = '';
try { profileNick = normalizeNick(localStorage.getItem('dimovie-profile')); } catch {}
let favorites = profileNick ? [] : readFavorites(), libraryRevision = 0, refreshFavorite = () => {};
const restoredProfileNick=profileNick;
let profileReady = profileNick ? profileLibrary(profileNick).then(data => {if(profileNick===restoredProfileNick && libraryRevision===0)favorites=data.movies;}).catch(()=>{}) : Promise.resolve();
function updateAccountButton() { $('account-tab').textContent=profileNick ? '👤 '+profileNick : 'Войти';$('account-tab').title=profileNick ? 'Библиотека профиля '+profileNick : 'Войти по нику'; }
updateAccountButton();
function readFavorites() {
  try {
    const items = JSON.parse(localStorage.getItem('dimovie-favorites') || '[]');
    return Array.isArray(items) ? items.filter(m => (Number.isInteger(m.id) || Number.isInteger(m.animeId)) && typeof m.title === 'string').slice(0, 100) : [];
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
  const poster = el('div', 'poster'); poster.append(movie.animeId ? animePoster(movie.poster_path, '') : image(movie.poster_path, 'w342'));
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
  $('catalog-tab').classList.toggle('active', !state.library && !state.anime); $('library-tab').classList.toggle('active', state.library);
  $('catalog-tab').setAttribute('aria-pressed', String(!state.library && !state.anime)); $('library-tab').setAttribute('aria-pressed', String(state.library));
  $('anime-tab').classList.toggle('selected', state.anime); $('anime-tab').setAttribute('aria-pressed', String(state.anime));
  $('search').placeholder = state.anime ? 'Название аниме…' : 'Название фильма…';
  $('search').setAttribute('aria-label', state.anime ? 'Поиск аниме' : 'Поиск фильмов');
  $('categories').hidden = false;
  document.querySelectorAll('.chip[data-category],#anime-tab').forEach(button=>{button.hidden=state.library || (!state.anime && !!state.query);});
  document.querySelectorAll('.chip[data-category]').forEach(button=>{const selected=!state.anime && button.dataset.category===state.category;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  $('status').textContent = '';
  $('status').classList.remove('library-empty');
  if (state.library) {
    if (profileNick) {
      const nick=profileNick, revision=libraryRevision;
      $('status').textContent='Загружаем библиотеку…';
      try {const data=await profileLibrary(nick,'get',{},signal);if(signal.aborted || nick!==profileNick)return;if(revision===libraryRevision)favorites=data.movies;$('status').textContent='';}
      catch(error){if(signal.aborted)return;$('status').textContent='Не удалось обновить библиотеку. '+error.message;}
    }
    const list = favorites.filter(m => m.title.toLocaleLowerCase('ru').includes(state.query.toLocaleLowerCase('ru')));
    $('grid').replaceChildren(...list.map(card));
    if (!list.length) {
      $('status').textContent = 'Здесь появятся сохранённые фильмы. Добавь их в избранное на странице фильма.';
      $('status').classList.add('library-empty');
    }
    return;
  }
  skeletons(); $('grid').setAttribute('aria-busy', 'true');
  try {
    const data = state.anime ? await animeCatalog(state.query, state.page, signal) : await api(state.query ? 'search/movie' : state.category, { page: state.page, ...(state.query ? { query: state.query } : {}) }, signal);
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
  if (movie.animeId) return openAnimeMovie(movie);
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
    const favorite = favoriteButton({id:details.id,title:details.title,poster_path:details.poster_path,release_date:details.release_date,vote_average:details.vote_average});
    const player = el('button', 'secondary', '▶ Смотреть онлайн'); player.addEventListener('click', () => $('inline-player').scrollIntoView({ block: 'start' }));
    actions.append(favorite, player);
    const note = el('p', 'note');
    body.append(title, meta, genres, el('p', 'overview', details.overview || 'Описание пока не добавлено.'), actions, note);
    content.replaceChildren(image(details.poster_path, 'w342', 'movie-poster'), body);
    openPlayer(details.title, posterUrl(details.backdrop_path, 'w1280'), details.external_ids?.imdb_id || details.imdb_id || '', {originalTitle:details.original_title, year:details.release_date?.slice(0,4)});
    document.title = `${details.title} — DIMovie`;
    if ((details.genres || []).some(genre => genre.id === 16)) findAnimeMovie(details.title, details.release_date?.slice(0,4), signal).then(release => {
      if (!release || signal.aborted) return;
      const button=el('button','secondary','▶ Смотреть через AniLiberty');
      button.addEventListener('click',()=>openAnimeMovie(animeCard(release)));actions.prepend(button);
    }).catch(()=>{});

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
document.querySelectorAll('.chip[data-category]').forEach(button => button.addEventListener('click', () => {
  clearTimeout(searchTimer); if (!$('watch-page').hidden) showCatalogue(); state.anime = false; state.library = false; state.category = button.dataset.category; state.page = 1; state.query = ''; $('search').value = '';
  document.querySelectorAll('.chip[data-category]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); load();
}));
for (const [id, library] of [['catalog-tab', false], ['library-tab', true]]) $(id).addEventListener('click', () => { clearTimeout(searchTimer); showCatalogue(); state.library = library; state.anime = false; state.page = 1; state.query = ''; $('search').value = ''; load(); });
for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => { state.page += delta; load(); window.scrollTo({ top: 0, behavior: 'instant' }); });
$('anime-tab').addEventListener('click',()=>{clearTimeout(searchTimer);showCatalogue();state.anime=true;state.library=false;state.page=1;state.query='';$('search').value='';load();});
$('retry').addEventListener('click', load);
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); $('search').focus(); } });
load();

function animePoster(path, className) {
  const src=animeImage(path);if (!src)return el('div',className);
  const img=el('img',className);img.src=src;img.alt='';img.loading='lazy';img.decoding='async';return img;
}
let animeEpisodes=[];
async function openAnimeMovie(movie) {
  detailController?.abort();detailController=new AbortController();const signal=detailController.signal;
  await stopPlayer();if(signal.aborted)return;
  catalogueScroll=window.scrollY;selectedMovie=null;
  $('catalog-page').hidden=true;$('watch-page').hidden=false;window.scrollTo({top:0,behavior:'instant'});
  const content=$('movie-content');content.replaceChildren(el('p','detail-body','Загружаем аниме…'));
  setupAnimePlayer(movie.title,animeImage(movie.poster_path));
  $('anime-note').textContent='';
  $('anime-episode').replaceChildren();$('anime-quality').replaceChildren();$('anime-episode').disabled=true;$('anime-quality').disabled=true;
  try {
    const release=await animeRelease(movie.animeId,signal);if(signal.aborted)return;
    setupAnimePlayer(release.name.main,animeImage(release.poster?.optimized?.preview || release.poster?.preview));
    const body=el('div','detail-body');body.append(el('h1','',release.name.main),el('p','metadata',`${release.year} · ${release.type?.description || 'Аниме'} · AniLiberty`),el('p','overview',release.description || ''));
    const animeActions=el('div','actions');animeActions.append(favoriteButton(animeCard(release)));body.append(animeActions);
    content.replaceChildren(animePoster(release.poster?.optimized?.preview || release.poster?.preview,'movie-poster'),body);
    document.title=release.name.main+' — DIMovie';
    animeEpisodes=playableEpisodes(release);
    $('anime-note').textContent=animeEpisodes.length ? '' : release.is_blocked_by_geo || release.is_blocked_by_copyrights ? 'Провайдер ограничил доступ к этому аниме.' : 'В этом релизе пока нет доступных видеосерий.';
    for (const episode of animeEpisodes) {const option=el('option','',`${release.type?.value==='MOVIE'?'Фильм':'Серия '+episode.ordinal}${episode.name?' · '+episode.name:''}`);option.value=String(episode.ordinal);$('anime-episode').append(option);}
    updateAnimeQuality();$('anime-episode').disabled=!animeEpisodes.length;$('anime-quality').disabled=!animeEpisodes.length;
  } catch(error) {if(!signal.aborted)$('anime-note').textContent=error.message;}
}
function updateAnimeQuality() {
  const episode=animeEpisodes.find(episode=>String(episode.ordinal)===$('anime-episode').value);
  const previous=$('anime-quality').value || '720';$('anime-quality').replaceChildren();
  for (const quality of episode?.qualities || []) {const option=el('option','',quality.quality+'p');option.value=String(quality.quality);$('anime-quality').append(option);}
  if ([...$('anime-quality').options].some(option=>option.value===previous))$('anime-quality').value=previous;
}
$('anime-episode').addEventListener('change',()=>{updateAnimeQuality();playSelectedAnime();});
async function playSelectedAnime() {
  const episode=animeEpisodes.find(episode=>String(episode.ordinal)===$('anime-episode').value);
  const quality=episode?.qualities.find(quality=>String(quality.quality)===$('anime-quality').value);
  if(!quality)return;
  try {await startAnimeStream(quality.url);$('video-shell').scrollIntoView({block:'center'});}catch(error){$('player-status').textContent=error.message;}
}
$('video-shell').addEventListener('anime-play',playSelectedAnime);

$('anime-quality').addEventListener('change',async()=>{
  const video=$('embedded-video');if(!video.getAttribute('src'))return;
  const episode=animeEpisodes.find(episode=>String(episode.ordinal)===$('anime-episode').value);
  const quality=episode?.qualities.find(quality=>String(quality.quality)===$('anime-quality').value);
  if(quality)try{await startAnimeStream(quality.url,video.currentTime);}catch(error){$('player-status').textContent=error.message;}
});
const linkedAnime=Number(new URLSearchParams(location.search).get('anime'));
if(Number.isSafeInteger(linkedAnime)&&linkedAnime>0){state.anime=true;state.library=false;load();openAnimeMovie({animeId:linkedAnime,title:'Аниме'});}

function favoriteButton(movie) {
  const button=el('button','primary');
  const refresh=()=>{const saved=favorites.some(row=>String(row.id)===String(movie.id));button.textContent=saved?'Убрать из библиотеки':'+ В библиотеку';button.setAttribute('aria-pressed',String(saved));};
  refreshFavorite=refresh;refresh();profileReady.then(refresh);
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try {
      await profileReady;
      const saved=favorites.some(row=>String(row.id)===String(movie.id));
      const record={...movie,title:movie.title.slice(0,200)};
      libraryRevision++;
      if(profileNick){const nick=profileNick;const data=await profileLibrary(nick,saved?'remove':'add',{movie:record});if(nick!==profileNick)return;favorites=data.movies;}
      else {const next=saved?favorites.filter(row=>String(row.id)!==String(movie.id)):[record,...favorites].slice(0,100);localStorage.setItem('dimovie-favorites',JSON.stringify(next));favorites=next;}
      refresh();if(state.library)load();
    } catch(error){button.textContent='Не удалось сохранить — повторить';button.title=error.message;}
    finally {button.disabled=false;}
  });
  return button;
}
$('account-tab').addEventListener('click',()=>{$('account-nick').value=profileNick;$('account-import').checked=false;$('account-status').textContent='';$('account-logout').hidden=!profileNick;$('account-dialog').showModal();});
$('account-close').addEventListener('click',()=>$('account-dialog').close());
$('account-form').addEventListener('submit',async event=>{
  event.preventDefault();$('account-submit').disabled=true;$('account-logout').disabled=true;
  try {
    const nick=normalizeNick($('account-nick').value);
    $('account-status').textContent='Открываем библиотеку…';
    const guest=readFavorites();
    const data=await profileLibrary(nick,$('account-import').checked && guest.length?'import':'get',$('account-import').checked && guest.length?{movies:guest}:{});
    localStorage.setItem('dimovie-profile',data.nick);profileNick=data.nick;libraryRevision++;favorites=data.movies;profileReady=Promise.resolve();
    updateAccountButton();refreshFavorite();$('account-dialog').close();if(state.library)load();
  }catch(error){$('account-status').textContent=error.message;}
  finally{$('account-submit').disabled=false;$('account-logout').disabled=false;}
});
$('account-logout').addEventListener('click',()=>{localStorage.removeItem('dimovie-profile');profileNick='';libraryRevision++;favorites=readFavorites();profileReady=Promise.resolve();updateAccountButton();refreshFavorite();$('account-dialog').close();if(state.library)load();});
