const $ = id => document.getElementById(id);
const video = $('embedded-video'), shell = $('video-shell');
let hideTimer, dragging = false, buffering = false, lastVolume = 1;
const paths = {
  play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/>',
  full: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  exit: '<path d="M4 9h5V4m6 0v5h5M9 20v-5H4m11 5v-5h5"/>'
};
function icon(button, name) {
  // Only static, locally defined SVG paths enter this markup.
  button.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function setControlTitle(title) { $('control-title').textContent = title; }
function showControls() {
  clearTimeout(hideTimer); shell.classList.remove('controls-hidden');
  if (!video.paused && !buffering && !dragging) hideTimer = setTimeout(() => {
    if (shell.contains(document.activeElement) && document.activeElement.matches(':focus-visible')) return;
    shell.classList.add('controls-hidden');
  }, 3000);
}
function updateTime() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!dragging) {
    $('video-seek').value = duration ? String(video.currentTime / duration * 1000) : '0';
    $('video-time').replaceChildren(document.createTextNode(formatTime(video.currentTime) + ' '), Object.assign(document.createElement('span'), {textContent: '/ ' + formatTime(duration)}));
  }
  $('video-seek').disabled = !duration;
  $('video-seek').setAttribute('aria-valuetext', `${formatTime(video.currentTime)} из ${formatTime(duration)}`);
  const played = duration ? video.currentTime / duration * 100 : 0;
  let buffered = played;
  if (duration && video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1) / duration * 100;
  $('video-seek').style.setProperty('--played', `${Math.min(100, played)}%`);
  $('video-seek').style.setProperty('--buffered', `${Math.min(100, buffered)}%`);
}
function updatePlay() {
  if (!buffering) $('center-play').hidden = !video.paused;
  icon($('toggle-play'), video.paused ? 'play' : 'pause');
  $('toggle-play').setAttribute('aria-label', video.paused ? 'Воспроизвести' : 'Пауза');
  $('player-state').textContent = !video.getAttribute('src') ? 'Готов к просмотру' : buffering ? 'Буферизация' : video.paused ? 'Пауза' : 'Просмотр';
  showControls();
}
function togglePlay() {
  if (!video.getAttribute('src')) $('center-play').click();
  else if (video.paused) video.play().catch(() => showControls());
  else video.pause();
}
function updateVolume() {
  const muted = video.muted || video.volume === 0;
  icon($('mute-video'), muted ? 'mute' : 'sound');
  $('mute-video').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  $('mute-video').setAttribute('aria-pressed', String(muted));
  $('video-volume').value = muted ? '0' : String(video.volume);
  $('video-volume').style.setProperty('--volume', `${muted ? 0 : video.volume * 100}%`);
  showControls();
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (shell.requestFullscreen) await shell.requestFullscreen();
    else if (video.webkitEnterFullscreen && video.getAttribute('src')) video.webkitEnterFullscreen();
    else $('player-state').textContent = 'Полный экран недоступен в этом браузере';
  } catch { $('player-state').textContent = 'Браузер не разрешил полный экран'; }
  showControls();
}
$('toggle-play').addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
video.addEventListener('dblclick', fullscreen);
$('fullscreen-video').addEventListener('click', fullscreen);
document.addEventListener('fullscreenchange', () => {
  const full = document.fullscreenElement === shell;
  icon($('fullscreen-video'), full ? 'exit' : 'full');
  $('fullscreen-video').setAttribute('aria-label', full ? 'Выйти из полного экрана' : 'На весь экран');
  showControls();
});
$('mute-video').addEventListener('click', () => {
  if (video.muted || video.volume === 0) { video.muted = false; video.volume = lastVolume || 1; }
  else { lastVolume = video.volume; video.muted = true; }
});
$('video-seek').addEventListener('input', event => {
  dragging = true; showControls();
  const time = Number(event.target.value) / 1000 * (video.duration || 0);
  $('video-time').textContent = `${formatTime(time)} / ${formatTime(video.duration)}`;
  event.target.style.setProperty('--played', `${Number(event.target.value) / 10}%`);
});
$('video-seek').addEventListener('change', event => {
  if (Number.isFinite(video.duration)) video.currentTime = Number(event.target.value) / 1000 * video.duration;
  dragging = false; showControls();
});
for (const event of ['pointermove', 'pointerdown', 'focusin']) shell.addEventListener(event, showControls);
shell.addEventListener('keydown', event => {
  if (event.target.tagName === 'INPUT' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === ' ' && event.target.tagName === 'BUTTON') return;
  const key = event.key.toLowerCase();
  if (key === ' ' || key === 'k') togglePlay();
  else if (key === 'f') fullscreen();
  else if (key === 'm') $('mute-video').click();
  else if (key === 'arrowleft') $('rewind-video').click();
  else if (key === 'arrowright') $('forward-video').click();
  else return;
  event.preventDefault(); showControls();
});
for (const event of ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'emptied']) video.addEventListener(event, updateTime);
for (const event of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(event, updatePlay);
video.addEventListener('waiting', () => { buffering = true; $('buffer-indicator').hidden = false; $('center-play').hidden = true; updatePlay(); });
for (const event of ['playing', 'canplay', 'error', 'emptied']) video.addEventListener(event, () => { buffering = false; $('buffer-indicator').hidden = true; updatePlay(); });
video.addEventListener('volumechange', updateVolume);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(hideTimer); else showControls(); });
icon($('stop-torrent'), 'stop'); icon($('fullscreen-video'), 'full');
updatePlay(); updateTime(); updateVolume();
video.controls = false;
