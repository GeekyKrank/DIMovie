// A prepared MP4 is a live HTTP response, not a seekable file. MSE makes its
// original presentation timestamps seekable without resetting each track.
let active;
export function stopPreparedStream() {
  if (!active) return;
  const state=active;active=null;state.abort.abort();
  state.reader?.cancel().catch(()=>{});
  state.video.removeEventListener('waiting',state.retry);
  state.video.removeEventListener('play',state.retry);
  URL.revokeObjectURL(state.objectUrl);
}
function mimeFor(bytes) {
  const hex=n=>n.toString(16).padStart(2,'0');
  for(let i=4;i+18<bytes.length;i++) {
    const type=String.fromCharCode(...bytes.subarray(i,i+4)),p=i+4;
    if(type==='avcC' && bytes[p]===1)return `video/mp4; codecs="avc1.${hex(bytes[p+1])}${hex(bytes[p+2])}${hex(bytes[p+3])},mp4a.40.2"`;
    if(type==='hvcC' && bytes[p]===1) {
      const profile=bytes[p+1],space=['','A','B','C'][profile>>6],tier=profile&32?'H':'L';
      let bits=0;for(let j=0;j<32;j++)bits=bits*2+((bytes[p+5-(j>>3)]>>(j%8))&1);
      const constraints=Array.from(bytes.subarray(p+6,p+12),hex);while(constraints.at(-1)==='00')constraints.pop();
      return `video/mp4; codecs="hvc1.${space}${profile&31}.${bits.toString(16)}.${tier}${bytes[p+12]}${constraints.length?'.'+constraints.join('.'):''},mp4a.40.2"`;
    }
    if(type==='vpcC')return `video/mp4; codecs="vp09.${String(bytes[p+4]).padStart(2,'0')}.${String(bytes[p+5]).padStart(2,'0')}.${String(bytes[p+6]>>4).padStart(2,'0')},mp4a.40.2"`;
    if(type==='av1C' && bytes[p]===129)return `video/mp4; codecs="av01.${bytes[p+1]>>5}.${String(bytes[p+1]&31).padStart(2,'0')}${bytes[p+2]&128?'H':'M'}.${bytes[p+2]&64?(bytes[p+2]&32?'12':'10'):'08'},mp4a.40.2"`;
  }
}
function once(target,event,signal) {
  return new Promise((resolve,reject)=>{
    const done=()=>{clean();resolve();},fail=()=>{clean();reject(new Error('Не удалось обработать видео'));},cancel=()=>{clean();reject(new DOMException('Cancelled','AbortError'));};
    const clean=()=>{target.removeEventListener(event,done);target.removeEventListener('error',fail);signal.removeEventListener('abort',cancel);};
    target.addEventListener(event,done,{once:true});target.addEventListener('error',fail,{once:true});signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
  });
}
export function startPreparedStream(video,url,duration,{fallback,onError,onRestart}) {
  const Source=globalThis.MediaSource || globalThis.ManagedMediaSource;
  if(!Source)return false;
  stopPreparedStream();
  const media=new Source(),abort=new AbortController(),objectUrl=URL.createObjectURL(media);
  const state={video,abort,objectUrl,failed:false,reader:null,retry(){if(state.failed && active===state){if(onRestart())state.failed=false;}}};active=state;
  video.addEventListener('waiting',state.retry);video.addEventListener('play',state.retry);
  const opened=once(media,'sourceopen',abort.signal);
  video.src=objectUrl;video.load();
  (async()=>{
    await opened;
    const response=await fetch(url,{signal:abort.signal,credentials:'omit'});
    if(!response.ok)throw new Error(response.status===503?'Обработка озвучки занята. Повтори через несколько секунд.':`Не удалось загрузить озвучку (${response.status})`);
    const reader=response.body.getReader();state.reader=reader;
    let initial=new Uint8Array(),mime;
    while(!mime) {
      const chunk=await reader.read();if(chunk.done)throw new Error('Пустой поток видео');
      const joined=new Uint8Array(initial.length+chunk.value.length);joined.set(initial);joined.set(chunk.value,initial.length);initial=joined;
      mime=mimeFor(initial);
      if(initial.length>2*1024*1024)break;
    }
    if(!mime || !Source.isTypeSupported(mime)) {if(active===state){stopPreparedStream();fallback();}return;}
    const buffer=media.addSourceBuffer(mime);
    if(Number.isFinite(duration) && duration>0)media.duration=duration;
    let chunk={value:initial,done:false};
    while(!chunk.done && active===state) {
      const updated=once(buffer,'updateend',abort.signal);buffer.appendBuffer(chunk.value);await updated;
      // Limit the retained back buffer and let fetch apply network backpressure.
      const oldEnd=video.currentTime-5;
      if(buffer.buffered.length && oldEnd>buffer.buffered.start(0)+5){const removed=once(buffer,'updateend',abort.signal);buffer.remove(0,oldEnd);await removed;}
      while(buffer.buffered.length && buffer.buffered.end(buffer.buffered.length-1)-video.currentTime>20 && active===state)await new Promise(resolve=>{const timer=setTimeout(done,500);function done(){clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve();}abort.signal.addEventListener('abort',done,{once:true});});
      chunk=await reader.read();
    }
    if(active===state && media.readyState==='open')media.endOfStream();
  })().catch(error=>{
    if(active!==state || abort.signal.aborted)return;
    state.failed=true;onError(error);
    // Keep already-buffered media available. A paused/disconnected response is
    // retried from the current movie time when playback needs more data.
    if(!video.paused && video.readyState<3)state.retry();
  });
  return true;
}
