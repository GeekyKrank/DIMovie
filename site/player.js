const BASE = 'https://158-180-61-121.sslip.io/dimovie-player';
const $ = id => document.getElementById(id);
let token = '', active = false, pollTimer, operation;
const video = $('embedded-video');
async function call(path, data = {}, signal) {
  if (path !== '/session' && !token) token = (await call('/session', {}, signal)).token;
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
  operation?.abort(); clearTimeout(pollTimer);
  video.pause(); video.removeAttribute('src'); video.load();
  $('file-picker').hidden = true;
  $('center-play').hidden = false; $('video-hint').hidden = false; $('torrent-stats').textContent = '';
  active = false;
  if (token) {
    try { await call('/stop'); } catch (error) { message(error.message); }
  }
}
export function openPlayer(title = '', poster = '') {
  $('player-heading').textContent = 'Смотреть онлайн';
  video.setAttribute('aria-label', title ? `Видео: ${title}` : 'Видеоплеер');
  if (poster) video.poster = poster; else video.removeAttribute('poster');
}
$('torrent-form').addEventListener('submit', async event => {
  event.preventDefault();
  await stopPlayer(); operation = new AbortController();
  const signal = operation.signal;
  $('load-torrent').disabled = true; $('file-picker').hidden = true;
  message('Получаем список файлов и подключаемся к пирам…');
  try {
    let data = await call('/torrent', { link: $('torrent-link').value.trim() }, signal);
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
    $('file-picker').hidden = false; message('Выбери файл и нажми «Смотреть».');
    statistics();
  } catch (error) { if (!signal.aborted) message(error.message); }
  finally { $('load-torrent').disabled = false; }
});
$('start-video').addEventListener('click', async () => {
  $('start-video').disabled = true; message('Накапливаем буфер…');
  try {
    const result = await call('/play', { index: Number($('video-file').value) });
    video.src = BASE + result.path; video.load();
    $('video-hint').hidden = true; $('player-setup').open = false;
    $('video-shell').scrollIntoView({ block: 'center' });
    await video.play().catch(() => message('Нажми ▶ на видео, чтобы начать просмотр.'));
  } catch (error) { message(error.message); }
  finally { $('start-video').disabled = false; }
});
video.addEventListener('playing', () => { $('center-play').hidden = true; message('Воспроизведение'); });
video.addEventListener('pause', () => { $('center-play').hidden = false; });
video.addEventListener('waiting', () => message('Накапливаем буфер. Скорость зависит от доступных пиров.'));
video.addEventListener('error', () => message('Не удалось воспроизвести видео. Браузер может не поддерживать кодек этой раздачи. Попробуй MP4 с H.264/AAC.'));
$('rewind-video').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
$('forward-video').addEventListener('click', () => { if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10); });
$('video-volume').addEventListener('input', event => { video.volume = Number(event.target.value); video.muted = video.volume === 0; });
$('stop-torrent').addEventListener('click', async () => { await stopPlayer(); $('file-picker').hidden = true; message('Просмотр остановлен, ресурсы освобождены.'); });
$('center-play').addEventListener('click', () => {
  if (video.getAttribute('src')) video.play().catch(() => message('Не удалось запустить видео. Попробуй другую раздачу.'));
  else if (!$('file-picker').hidden) $('start-video').click();
  else { $('player-setup').open = true; $('torrent-link').focus(); $('player-setup').scrollIntoView({ block: 'center' }); }
});
$('toggle-source').addEventListener('click', () => { $('player-setup').open = !$('player-setup').open; if ($('player-setup').open) $('player-setup').scrollIntoView({ block: 'center' }); });
$('player-setup').addEventListener('toggle', () => $('toggle-source').setAttribute('aria-expanded', String($('player-setup').open)));
window.addEventListener('pagehide', () => {
  if (active && token) fetch(BASE + '/stop', { method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
});
