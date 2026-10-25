import {startPreparedStream, stopPreparedStream} from './prepared-stream.js?v=sync-20261025';
const video = document.getElementById('embedded-video');
let source = '', loader, info, offset = 0, selected = null, pending, infoPromise, compatibilityAttempted = false;
let pendingPosition = null, metadataListener, playingIntent = false, revision = 0, streamRetries = 0;
function wantsPlayback() { return pendingPosition !== null ? playingIntent : !video.paused; }
function reportPlayError(error, ticket) {
  if (ticket === revision && error.name !== 'AbortError') document.getElementById('player-status').textContent = 'Нажми ▶ для продолжения просмотра.';
}
function awaitPosition(time, apply) {
  if (metadataListener) video.removeEventListener('loadedmetadata', metadataListener);
  pendingPosition = time;
  metadataListener = () => { pendingPosition = null; metadataListener = null; apply?.(); };
  video.addEventListener('loadedmetadata', metadataListener, {once:true});
}
export function configureTransport(url = '', loadInfo) {
  stopPreparedStream(); streamRetries = 0;
  revision++;
  pending?.abort(); pending = null;
  infoPromise = null;
  if (metadataListener) video.removeEventListener('loadedmetadata', metadataListener);
  metadataListener = null; pendingPosition = null; playingIntent = false;
  source = url; loader = loadInfo; info = null; offset = 0; selected = null; compatibilityAttempted = false;
  video.dispatchEvent?.(new Event('transportchange'));
}
export function playbackDuration() { return selected !== null ? info?.duration || 0 : video.duration; }
export function playbackTime() { return pendingPosition ?? offset + video.currentTime; }
export function selectedServerAudio() { return selected; }
export function originalAudio() {
  const time = playbackTime(), resume = wantsPlayback(), ticket = ++revision;
  playingIntent = resume;
  stopPreparedStream();
  selected = null; offset = 0;
  awaitPosition(time, () => { video.currentTime = time; if (resume) video.play().catch(error => reportPlayError(error, ticket)); });
  video.src = source; video.load();
}
export async function serverAudioTracks() {
  if (!source) throw new Error('Сначала запусти фильм.');
  if (!loader) throw new Error('У этого потока озвучка задана AniLiberty. Серверная смена звука не используется.');
  if (info) return info;
  if (infoPromise) return infoPromise;
  const request = new AbortController(); pending = request;
  infoPromise = (async () => {
    const result = await loader(request.signal);
    if (request.signal.aborted) throw new Error('Источник изменился. Открой меню снова.');
    info = result; return info;
  })().finally(() => { if (pending === request) { pending = null; infoPromise = null; } });
  return infoPromise;
}

export async function ensureCompatibleAudio() {
  const metadata = await serverAudioTracks();
  if (selected !== null) return false;
  const original = metadata.tracks.find(track => track.default) || metadata.tracks[0];
  if (!original) return false;
  const codecs = {ac3:'ac-3', eac3:'ec-3', dts:'dtsc', truehd:'mlpa'};
  const codec = codecs[original.codec];
  if (!codec || video.canPlayType?.(`audio/mp4; codecs="${codec}"`)) return false;
  const track = metadata.tracks.find(track => /^(ru|rus)$/i.test(track.language)) || original;
  selectServerAudio(track.index);
  return true;
}
function reloadAt(time, resume) {
  const target = Math.max(0, Math.min(time, Math.max(0, (info?.duration || time + 1) - .1)));
  const absolute = info?.audio_timeline === 'source', ticket = ++revision;
  playingIntent = resume;
  offset = absolute ? 0 : target;
  awaitPosition(target, () => {
    if (absolute) video.currentTime = target;
    if (playingIntent) video.play().catch(error => reportPlayError(error, ticket));
  });
  const url = `${source}/${absolute ? 'audio-v2' : 'audio'}/${selected}/${target.toFixed(3)}`;
  const fallback = () => { video.src = url; video.load(); };
  const streaming = absolute && startPreparedStream(video, url, info.duration, {
    fallback,
    onError(error) { if (ticket === revision) document.getElementById('player-status').textContent = error.message; },
    onRestart() { if (ticket !== revision || streamRetries >= 2) return false; streamRetries++; reloadAt(playbackTime(), wantsPlayback()); return true; }
  });
  if (!streaming) fallback();
  // Metadata restores the exact movie time before playback starts. Starting
  // earlier would briefly play the keyframe preceding the requested position.
}
export function selectServerAudio(index) {
  const incompatible = info?.video_codecs?.find(codec => ['mpeg4','msmpeg4v3','mpeg2video','mpeg1video','wmv3','vc1','h263'].includes(codec));
  if (incompatible) { video.pause(); throw new Error(`Видео ${incompatible.toUpperCase()} не поддерживается браузером. Нужна другая раздача H.264/AAC или внешний плеер.`); }
  if (!info?.tracks.some(t => t.index === index)) throw new Error('Дорожка недоступна');
  if (selected === index) return;
  streamRetries = 0;
  const time = playbackTime(), resume = wantsPlayback();
  selected = index; reloadAt(time, resume);
}
export function seekPlayback(time) {
  if (!Number.isFinite(time)) return;
  streamRetries = 0;
  time = Math.max(0, Math.min(time, Number.isFinite(playbackDuration()) ? Math.max(0, playbackDuration() - .1) : time));
  if (selected !== null) {
    if (info?.audio_timeline === 'source' && pendingPosition === null) {
      for (let i = 0; i < video.buffered.length; i++) if (time >= video.buffered.start(i) && time < video.buffered.end(i)) { video.currentTime = time; return; }
    }
    reloadAt(time, wantsPlayback());
  }
  else video.currentTime = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
}

export async function recoverCompatiblePlayback(errorCode) {
  if (![3,4].includes(errorCode) || !source || selected !== null || compatibilityAttempted) return false;
  compatibilityAttempted = true;
  const currentSource = source;
  const metadata = await serverAudioTracks();
  if (currentSource !== source) return false;
  const track = metadata.tracks.find(track => /^(ru|rus)$/i.test(track.language)) || metadata.tracks[0];
  if (!track) throw new Error('В файле не найдена звуковая дорожка. Попробуй другую раздачу.');
  selectServerAudio(track.index);
  // A failed source may already report paused=true. The recovery still serves
  // a user's playback request; the metadata callback starts it at the right time.
  playingIntent = true;
  return true;
}
