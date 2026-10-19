import { playbackTime, playbackDuration, serverAudioTracks, selectServerAudio, seekPlayback } from './transport.js?v=server-audio-1';
import { audioLabel, selectAudioTrack } from './audio.js?v=audio-menu-1';
const $ = id => document.getElementById(id);
const video = $('embedded-video'), shell = $('video-shell');
let hideTimer, dragging = false, buffering = false, lastVolume = 1;
const paths = {
  play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
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
  if (!video.paused && !buffering && !dragging && $('audio-panel').hidden) hideTimer = setTimeout(() => {
    if (shell.contains(document.activeElement) && document.activeElement.matches(':focus-visible')) return;
    shell.classList.add('controls-hidden');
  }, 3000);
}
function updateTime() {
  const duration = Number.isFinite(playbackDuration()) ? playbackDuration() : 0;
  if (!dragging) {
    $('video-seek').value = duration ? String(playbackTime() / duration * 1000) : '0';
    $('video-time').replaceChildren(document.createTextNode(formatTime(playbackTime()) + ' '), Object.assign(document.createElement('span'), {textContent: '/ ' + formatTime(duration)}));
  }
  $('video-seek').disabled = !duration;
  $('video-seek').setAttribute('aria-valuetext', `${formatTime(playbackTime())} из ${formatTime(duration)}`);
  const played = duration ? playbackTime() / duration * 100 : 0;
  let buffered = played;
  if (duration && video.buffered.length) buffered = (playbackTime() - video.currentTime + video.buffered.end(video.buffered.length - 1)) / duration * 100;
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
let audioMode = 'native', audioLoading = false;
function refreshAudio() {
  if (audioMode === 'server') return;
  const select = $('audio-track');
  select.replaceChildren();
  const tracks = video.audioTracks;
  if (tracks) for (let i = 0; i < tracks.length; i++) {
    const option = document.createElement('option');
    option.value = String(i); option.textContent = audioLabel(tracks[i], i);
    option.selected = tracks[i].enabled; select.append(option);
  }
  select.hidden = !tracks?.length;
  select.disabled = !tracks?.length;
  $('audio-message').textContent = !video.getAttribute('src') ? 'Сначала запусти фильм.'
    : !tracks ? 'Этот браузер не предоставляет выбор дорожек этого файла. Выбери другую раздачу с нужной озвучкой. Для переключения внутри файла требуется совместимый браузер или подготовка звука на сервере.'
    : !tracks.length ? 'Дорожки ещё не определены. Дождись загрузки видео. Если список не появится, браузер не поддерживает выбор звука в этом файле.'
    : tracks.length === 1 ? 'Браузер обнаружил одну звуковую дорожку.' : 'Выбери язык или название озвучки. Список получен из файла.';
}
function closeAudio() { $('audio-panel').hidden = true; $('audio-menu').setAttribute('aria-expanded', 'false'); showControls(); }
$('audio-menu').addEventListener('click', async () => {
  const opening = $('audio-panel').hidden;
  $('audio-panel').hidden = !opening; $('audio-menu').setAttribute('aria-expanded', String(opening));
  if (opening) {
    refreshAudio();
    if (video.getAttribute('src') && !video.audioTracks?.length && !audioLoading) {
      audioLoading = true; $('audio-message').textContent = 'Сервер определяет дорожки… Это может занять до 40 секунд.';
      try {
        const info = await serverAudioTracks(); audioMode = 'server';
        $('audio-track').replaceChildren();
        const original = document.createElement('option'); original.value = ''; original.textContent = 'Исходный звук'; $('audio-track').append(original);
        for (const track of info.tracks) { const option = document.createElement('option'); option.value = String(track.index); option.textContent = audioLabel(track, track.index) + (track.codec ? ' · ' + track.codec.toUpperCase() : ''); $('audio-track').append(option); }
        $('audio-track').hidden = !info.tracks.length; $('audio-track').disabled = !info.tracks.length;
        $('audio-message').textContent = info.tracks.length ? 'Выбери озвучку. Сервер подготовит звук AAC, сохранив видео и позицию просмотра. При перемотке возможна короткая буферизация.' : 'В этом файле не найдены звуковые дорожки.';
      } catch (error) { $('audio-message').textContent = error.message; }
      finally { audioLoading = false; }
    }
  } showControls();
});
$('audio-close').addEventListener('click', closeAudio);
$('audio-track').addEventListener('change', event => {
  try {
    if (audioMode === 'server') { if (event.target.value === '') return; selectServerAudio(Number(event.target.value)); }
    else if (!selectAudioTrack(video.audioTracks, Number(event.target.value))) throw new Error();
    $('audio-message').textContent = 'Выбрано: ' + event.target.selectedOptions[0].textContent;
  } catch { $('audio-message').textContent = 'Браузер не смог переключить эту дорожку. Попробуй другой источник.'; }
  showControls();
});
video.addEventListener('emptied', () => { if (!video.getAttribute('src')) { audioMode = 'native'; $('audio-panel').hidden = true; $('audio-menu').setAttribute('aria-expanded', 'false'); } });
for (const event of ['loadedmetadata', 'loadeddata', 'emptied']) video.addEventListener(event, refreshAudio);
for (const event of ['addtrack', 'removetrack', 'change']) video.audioTracks?.addEventListener(event, refreshAudio);
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
  const time = Number(event.target.value) / 1000 * (playbackDuration() || 0);
  $('video-time').textContent = `${formatTime(time)} / ${formatTime(playbackDuration())}`;
  event.target.style.setProperty('--played', `${Number(event.target.value) / 10}%`);
});
$('video-seek').addEventListener('change', event => {
  if (Number.isFinite(playbackDuration())) seekPlayback(Number(event.target.value) / 1000 * playbackDuration());
  dragging = false; showControls();
});
for (const event of ['pointermove', 'pointerdown', 'focusin']) shell.addEventListener(event, showControls);
shell.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('audio-panel').hidden) { closeAudio(); $('audio-menu').focus(); event.preventDefault(); return; }
  if (['INPUT', 'SELECT'].includes(event.target.tagName) || event.altKey || event.ctrlKey || event.metaKey) return;
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
icon($('fullscreen-video'), 'full');
updatePlay(); updateTime(); updateVolume();
video.controls = false;
