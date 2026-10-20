import { playHls, stopHls } from './hls-player.js?v=resume-2';
import { configureTransport, seekPlayback, playbackTime, playbackDuration, recoverCompatiblePlayback } from './transport.js?v=resume-2';
import { searchSources, sortSources, matchMovieSources } from './sources.js?v=movie-match-2';
import { setControlTitle } from './controls.js?v=resume-2';
const BASE = 'https://158-180-61-121.sslip.io/dimovie-player';
const $ = id => document.getElementById(id);
let directMode = false;
let token = '', active = false, pollTimer, operation;
let currentMovie = {}, currentImdb = '', sourceController, sourceLoading = false, sessionPromise;
const video = $('embedded-video');
async function call(path, data = {}, signal) {
  if (path !== '/session' && !token) {
    sessionPromise ||= call('/session', {}).then(result => result.token).finally(() => { sessionPromise = null; });
    token = await sessionPromise;
  }
  let response;
  try {
    response = await fetch(BASE + path, { method: 'POST', credentials: 'omit', signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Сервер не отвечает. Проверь подключение и повтори попытку.');
  }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) token = '';
    throw new Error(result.error || 'Не удалось выполнить запрос');
  }
  return result;
}
function message(text) { $('player-status').textContent = text; }
function bytes(size) {
  return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} ГБ` : `${(size / 1024 ** 2).toFixed(1)} МБ`;
}
async function statistics() {
  if (!active || $('watch-page').hidden) return;
  try {
    const data = await call('/status');
    if (!active) return;
    $('torrent-stats').textContent = `${(data.speed / 1024).toFixed(0)} КиБ/с · пиров: ${data.peers}`;
  } catch (error) { $('torrent-stats').textContent = error.message; }
  if (active) pollTimer = setTimeout(statistics, 5000);
}
export async function stopPlayer() {
  directMode = false; stopHls();
  sourceController?.abort();
  operation?.abort(); clearTimeout(pollTimer);
  configureTransport();
  video.pause(); video.removeAttribute('src'); video.load();
  $('file-picker').hidden = true;
  $('center-play').hidden = false; $('video-hint').hidden = false; $('torrent-stats').textContent = '';
  active = false;
  if (token) {
    try { await call('/stop'); } catch (error) { message(error.message); }
  }
}
export function openPlayer(title = '', poster = '', imdb = '', movie = {}) {
  $('anime-options').hidden = true; $('toggle-source').hidden = false;
  $('anime-panel').hidden = true; $('source-panel').hidden = false; $('player-setup').hidden = false; $('toggle-source').textContent = 'Выбрать источник';
  $('video-hint').textContent = 'Выбери источник ниже, чтобы начать просмотр';
  currentMovie = {title, ...movie};
  setControlTitle(title || 'DIMovie');
  $('player-heading').textContent = 'Смотреть онлайн';
  video.setAttribute('aria-label', title ? `Видео: ${title}` : 'Видеоплеер');
  if (poster) video.poster = poster; else video.removeAttribute('poster');
  currentImdb = imdb;
  findSources();
}
let displayedSources = [], sourceCards = new Map(), sortMode = '', sortAscending = false, sortLanguage = 'ru';
function applySourceSort() {
  const ordered = sortMode ? sortSources(displayedSources, sortMode, sortAscending, sortLanguage) : displayedSources;
  $('source-list').replaceChildren(...ordered.map(source => sourceCards.get(source)));
  for (const mode of ['quality','language','peers']) $('sort-' + mode).setAttribute('aria-pressed', String(sortMode === mode));
  $('sort-quality').textContent = 'Качество ' + (sortMode === 'quality' && sortAscending ? '↑' : '↓');
  $('sort-peers').textContent = 'Пиры ' + (sortMode === 'peers' && sortAscending ? '↑' : '↓');
  $('sort-language').textContent = 'Озвучка: ' + (sortLanguage === 'uk' ? 'украинский' : 'русский');
}
for (const mode of ['quality','language','peers']) $('sort-' + mode).addEventListener('click', () => {
  if (mode === 'language') { if (sortMode === mode) sortLanguage = sortLanguage === 'ru' ? 'uk' : 'ru'; }
  else sortAscending = sortMode === mode ? !sortAscending : false;
  sortMode = mode; applySourceSort();
});
async function findSources() {
  sourceController?.abort(); sourceController = new AbortController();
  const signal = sourceController.signal;
  $('source-list').replaceChildren();
  displayedSources = []; sourceCards = new Map(); $('source-sorting').hidden = true;
  $('refresh-sources').disabled = true;
  if (!currentImdb) {
    $('sources-status').textContent = 'Выбери фильм в каталоге. Если у фильма нет IMDb ID, автоматический поиск недоступен.';
    $('refresh-sources').disabled = false;
    return;
  }
  $('sources-status').textContent = 'Ищем доступные раздачи…';
  try {
    const result = await searchSources(currentImdb, signal);
    if (signal.aborted) return;
    const matching = matchMovieSources(result.streams, currentMovie);
    $('sources-status').textContent = matching.length ? '' : 'Подходящие раздачи этого фильма не найдены. Явно посторонние сериальные раздачи скрыты.';
    if (matching.length && matching.every(source => source.seeders === 0)) $('sources-status').textContent = 'Все найденные раздачи указаны с нулём раздающих. Доступность не подтверждена.';
    if (result.unavailable?.length) $('sources-status').textContent = result.streams.length ? 'Часть источников временно недоступна.' : 'Часть источников не ответила. Попробуй повторить поиск позже.';
    displayedSources = matching;
    $('source-sorting').hidden = !displayedSources.length;
    for (const source of matching) {
      const card = document.createElement('article'); card.className = 'source-card';
      const header = document.createElement('div'); header.className = 'source-title';
      const name = document.createElement('strong'); name.textContent = source.name; header.append(name);
      if (source.russian) { const badge = document.createElement('span'); badge.className = 'russian-badge'; badge.textContent = 'Русский'; header.append(badge); }
      if (source.ukrainian) { const badge = document.createElement('span'); badge.className = 'ukrainian-badge'; badge.textContent = 'Українська'; header.append(badge); }
      const description = document.createElement('p'); description.className = 'source-description'; description.textContent = source.title;
      const meta = document.createElement('p'); meta.className = 'source-meta'; meta.textContent = [source.providers?.join(' · '), source.quality, source.size ? bytes(source.size) : '', source.seeders !== null ? `Раздающих: ${source.seeders}` : 'Число раздающих не указано'].filter(Boolean).join(' · ');
      const play = document.createElement('button'); play.className = 'primary'; play.textContent = '▶ Смотреть'; play.setAttribute('aria-label', `Смотреть: ${source.name} ${source.seeders || 0} раздающих`);
      play.addEventListener('click', () => loadTorrent('magnet:?xt=urn:btih:' + source.hash, source, true));
      card.append(header, description, meta);
      if (source.codecWarning) { const warning = document.createElement('p'); warning.className = 'note'; warning.textContent = 'HEVC/DTS/TrueHD может не поддерживаться этим браузером.'; card.append(warning); }
      card.append(play); sourceCards.set(source, card);
    }
    applySourceSort();
  } catch (error) { if (!signal.aborted) $('sources-status').textContent = error.message; }
  finally { if (!signal.aborted) $('refresh-sources').disabled = false; }
}
$('refresh-sources').addEventListener('click', findSources);
$('torrent-form').addEventListener('submit', async event => {
  event.preventDefault();
  loadTorrent($('torrent-link').value.trim());
});
async function loadTorrent(link, preferred = null, autoStart = false) {
  if (sourceLoading) return;
  sourceLoading = true;
  await stopPlayer(); operation = new AbortController();
  const signal = operation.signal;
  $('load-torrent').disabled = true; $('file-picker').hidden = true;
  message('Получаем список файлов и подключаемся к пирам…');
  try {
    let data = await call('/torrent', { link }, signal);
    active = true;
    const deadline = Date.now() + 90_000;
    while (!data.files.length && Date.now() < deadline && !signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (signal.aborted) return;
      data = await call('/status', {}, signal);
    }
    if (signal.aborted) return;
    const files = data.files.filter(f => /\.(mp4|m4v|mkv|webm|mov|avi|ts)$/i.test(f.name));
    if (!files.length) throw new Error('Видео не найдено или пиры не передали список файлов. Попробуй другую раздачу.');
    files.sort((a, b) => b.size - a.size);
    $('video-file').replaceChildren(...files.map(file => { const option = document.createElement('option'); option.value = String(file.id); option.textContent = `${file.name} · ${bytes(file.size)}`; return option; }));
    const selected = preferred && (files.find(f => preferred.filename && f.name.split('/').pop() === preferred.filename.split('/').pop()) || files.find(f => preferred.fileIdx !== null && f.id === preferred.fileIdx + 1));
    if (selected) $('video-file').value = String(selected.id);
    $('file-picker').hidden = false; message('Выбери файл и нажми «Смотреть».');
    statistics();
    if (autoStart) await startVideo();
  } catch (error) { if (!signal.aborted) message(error.message); }
  finally { $('load-torrent').disabled = false; sourceLoading = false; }
}
async function startVideo() {
  $('start-video').disabled = true; message('Накапливаем буфер…');
  try {
    const result = await call('/play', { index: Number($('video-file').value) });
    configureTransport(BASE + result.path, signal => call('/audio-info', {stream:result.path.split('/').pop()}, signal));
    video.dispatchEvent(new Event('resume-request'));
    video.src = BASE + result.path; video.load();
    $('video-hint').hidden = true; $('player-setup').open = false;
    $('video-shell').scrollIntoView({ block: 'center' });
    const requestedSource = video.src;
    video.play().catch(error => { if (video.src === requestedSource && error.name === 'NotAllowedError') message('Нажми ▶ на видео, чтобы начать просмотр.'); });
  } catch (error) { message(error.message); }
  finally { $('start-video').disabled = false; }
}
$('start-video').addEventListener('click', startVideo);
video.addEventListener('playing', () => { $('center-play').hidden = true; message('Воспроизведение'); });
video.addEventListener('pause', () => { $('center-play').hidden = false; });
video.addEventListener('waiting', () => message(directMode ? 'Загружаем поток AniLiberty…' : 'Накапливаем буфер. Скорость зависит от доступных пиров.'));
async function handlePlaybackFailure(code = video.error?.code) {
  const failedSource = video.getAttribute('src');
  if (!failedSource) return;
  if (directMode) {message('Не удалось открыть поток AniLiberty. Попробуй другое качество или повтори запуск.');return;}
  message('Проверяем совместимость файла и готовим MP4 со звуком AAC…');
  try {
    const recovered = await recoverCompatiblePlayback(code);
    if (!recovered && failedSource === video.getAttribute('src')) {
      if ([3,4].includes(code)) video.pause();
      message(code === 2
      ? 'Ошибка передачи видео. Проверь скорость раздачи или выбери другой источник.'
      : 'Видеокодек не поддерживается браузером. Переупаковка не исправляет Xvid/DivX и другие несовместимые кодеки. Выбери H.264/AAC.');
    }
  } catch (error) {
    if (failedSource === video.getAttribute('src') || video.error) message('Не удалось подготовить совместимое видео. ' + error.message + ' Попробуй источник H.264/AAC.');
  }
}
video.addEventListener('error', () => handlePlaybackFailure());
let checkingMissingVideo = false;
video.addEventListener('timeupdate', () => {
  if (!checkingMissingVideo && !video.paused && video.readyState >= 2 && video.currentTime > 2 && video.videoWidth === 0) {
    checkingMissingVideo = true;
    handlePlaybackFailure(4).finally(() => { checkingMissingVideo = false; });
  }
});
$('rewind-video').addEventListener('click', () => { seekPlayback(playbackTime() - 10); });
$('forward-video').addEventListener('click', () => { if (Number.isFinite(playbackDuration())) seekPlayback(Math.min(playbackDuration(), playbackTime() + 10)); });
$('video-volume').addEventListener('input', event => { video.volume = Number(event.target.value); video.muted = video.volume === 0; });
$('center-play').addEventListener('click', () => {
  if (directMode && !video.getAttribute('src')) { $('video-shell').dispatchEvent(new Event('anime-play')); return; }
  if (video.getAttribute('src')) video.play().catch(() => message('Не удалось запустить видео. Попробуй другую раздачу.'));
  else if (!$('file-picker').hidden) $('start-video').click();
  else if (currentImdb) $('source-panel').scrollIntoView({ block: 'start' });
  else { $('sources-status').textContent = 'Открой фильм в каталоге — сайт найдёт доступные источники.'; $('source-panel').scrollIntoView({ block: 'start' }); }
});
$('toggle-source').addEventListener('click', () => $(directMode ? 'anime-panel' : 'source-panel').scrollIntoView({ block: 'start' }));
window.addEventListener('pagehide', () => {
  if (active && token) fetch(BASE + '/stop', { method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
});

export function setupAnimePlayer(title, poster) {
  directMode=true;
  $('anime-options').hidden=false;$('toggle-source').hidden=true;
  $('anime-panel').hidden=false;$('source-panel').hidden=true;$('player-setup').hidden=true;
  $('toggle-source').textContent='Серии и качество';
  $('player-heading').textContent='Смотреть аниме';
  setControlTitle(title);video.poster=poster || '';
  video.setAttribute('aria-label','Видео: '+title);
  $('video-hint').hidden=false;$('video-hint').textContent='Выбери серию и нажми ▶ на плеере';
  message('Прямой поток AniLiberty · без торрент-пиров');
}
export async function startAnimeStream(url, start=0) {
  if (!directMode) return;
  configureTransport(url);
  $('video-hint').hidden=true;message('Загружаем поток AniLiberty…');
  await playHls(video,url,message,start);
}
