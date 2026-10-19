const video = document.getElementById('embedded-video');
let source = '', loader, info, offset = 0, selected = null, pending;
export function configureTransport(url = '', loadInfo) {
  pending?.abort(); pending = null;
  source = url; loader = loadInfo; info = null; offset = 0; selected = null;
}
export function playbackDuration() { return selected !== null ? info?.duration || 0 : video.duration; }
export function playbackTime() { return offset + video.currentTime; }
export async function serverAudioTracks() {
  if (!source || !loader) throw new Error('Сначала запусти фильм.');
  if (info) return info;
  pending?.abort(); const request = new AbortController(); pending = request;
  const result = await loader(request.signal);
  if (request.signal.aborted) throw new Error('Источник изменился. Открой меню снова.');
  info = result; return info;
}
function reloadAt(time, resume) {
  offset = Math.max(0, Math.min(time, Math.max(0, (info?.duration || time + 1) - .1)));
  video.src = `${source}/audio/${selected}/${offset.toFixed(3)}`;
  video.load();
  if (resume) video.play().catch(() => { document.getElementById('player-status').textContent = 'Нажми ▶ для продолжения с выбранной озвучкой.'; });
}
export function selectServerAudio(index) {
  if (!info?.tracks.some(t => t.index === index)) throw new Error('Дорожка недоступна');
  const time = playbackTime(), resume = !video.paused;
  selected = index; reloadAt(time, resume);
}
export function seekPlayback(time) {
  if (selected !== null) reloadAt(time, !video.paused);
  else video.currentTime = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
}
