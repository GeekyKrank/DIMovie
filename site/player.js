import { configureTransport, seekPlayback, playbackTime, playbackDuration } from './transport.js?v=server-audio-1';
import { searchSources } from './sources.js?v=source-search-2';
import { setControlTitle } from './controls.js?v=server-audio-1';
const BASE = 'https://158-180-61-121.sslip.io/dimovie-player';
const $ = id => document.getElementById(id);
let token = '', active = false, pollTimer, operation;
let currentImdb = '', sourceController, sourceLoading = false, sessionPromise;
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
export function openPlayer(title = '', poster = '', imdb = '') {
  setControlTitle(title || 'DIMovie');
  $('player-heading').textContent = 'Смотреть онлайн';
  video.setAttribute('aria-label', title ? `Видео: ${title}` : 'Видеоплеер');
  if (poster) video.poster = poster; else video.removeAttribute('poster');
  currentImdb = imdb;
  findSources();
}
async function findSources() {
  sourceController?.abort(); sourceController = new AbortController();
  const signal = sourceController.signal;
  $('source-list').replaceChildren();
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
    $('sources-status').textContent = result.streams.length ? `${result.provider}: найдено ${result.streams.length}. Синяя метка — русский звук, жёлтая — украинский, по данным источника. Совместимость кодеков проверяется при запуске.` : 'Дополнение не нашло раздачи для этого фильма. Попробуй позже или выбери другой фильм.';
    for (const source of result.streams) {
      const card = document.createElement('article'); card.className = 'source-card';
      const header = document.createElement('div'); header.className = 'source-title';
      const name = document.createElement('strong'); name.textContent = source.name; header.append(name);
      if (source.russian) { const badge = document.createElement('span'); badge.className = 'russian-badge'; badge.textContent = 'Русский'; header.append(badge); }
      if (source.ukrainian) { const badge = document.createElement('span'); badge.className = 'ukrainian-badge'; badge.textContent = 'Українська'; header.append(badge); }
      const description = document.createElement('p'); description.className = 'source-description'; description.textContent = source.title;
      const meta = document.createElement('p'); meta.className = 'source-meta'; meta.textContent = [source.quality, source.size ? bytes(source.size) : '', source.seeders !== null ? `Раздающих: ${source.seeders}` : 'Число раздающих не указано'].filter(Boolean).join(' · ');
      const play = document.createElement('button'); play.className = 'primary'; play.textContent = '▶ Смотреть'; play.setAttribute('aria-label', `Смотреть: ${source.name} ${source.seeders || 0} раздающих`);
      play.addEventListener('click', () => loadTorrent('magnet:?xt=urn:btih:' + source.hash, source, true));
      card.append(header, description, meta);
      if (source.codecWarning) { const warning = document.createElement('p'); warning.className = 'note'; warning.textContent = 'HEVC/DTS/TrueHD может не поддерживаться этим браузером.'; card.append(warning); }
      card.append(play); $('source-list').append(card);
    }
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
    video.src = BASE + result.path; video.load();
    $('video-hint').hidden = true; $('player-setup').open = false;
    $('video-shell').scrollIntoView({ block: 'center' });
    const requestedSource = video.src;
    video.play().catch(() => { if (video.src === requestedSource) message('Нажми ▶ на видео, чтобы начать просмотр.'); });
  } catch (error) { message(error.message); }
  finally { $('start-video').disabled = false; }
}
$('start-video').addEventListener('click', startVideo);
video.addEventListener('playing', () => { $('center-play').hidden = true; message('Воспроизведение'); });
video.addEventListener('pause', () => { $('center-play').hidden = false; });
video.addEventListener('waiting', () => message('Накапливаем буфер. Скорость зависит от доступных пиров.'));
video.addEventListener('error', () => message('Не удалось воспроизвести видео. Браузер может не поддерживать кодек этой раздачи. Попробуй MP4 с H.264/AAC.'));
$('rewind-video').addEventListener('click', () => { seekPlayback(playbackTime() - 10); });
$('forward-video').addEventListener('click', () => { if (Number.isFinite(playbackDuration())) seekPlayback(Math.min(playbackDuration(), playbackTime() + 10)); });
$('video-volume').addEventListener('input', event => { video.volume = Number(event.target.value); video.muted = video.volume === 0; });
$('center-play').addEventListener('click', () => {
  if (video.getAttribute('src')) video.play().catch(() => message('Не удалось запустить видео. Попробуй другую раздачу.'));
  else if (!$('file-picker').hidden) $('start-video').click();
  else if (currentImdb) $('source-panel').scrollIntoView({ block: 'start' });
  else { $('sources-status').textContent = 'Открой фильм в каталоге — сайт найдёт доступные источники.'; $('source-panel').scrollIntoView({ block: 'start' }); }
});
$('toggle-source').addEventListener('click', () => $('source-panel').scrollIntoView({ block: 'start' }));
window.addEventListener('pagehide', () => {
  if (active && token) fetch(BASE + '/stop', { method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
});
