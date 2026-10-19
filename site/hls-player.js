let engine, generation=0;
export function stopHls() {generation++;engine?.destroy();engine=null;}
export async function playHls(video, url, onError, start=0) {
  stopHls();const ticket=generation;
  const {default:Hls}=await import('./vendor/hls.light.min.mjs');
  if(ticket!==generation)return;
  if (!Hls.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src=url;video.load();
    if (start) video.addEventListener('loadedmetadata',()=>{if(ticket===generation)video.currentTime=start;},{once:true});
  } else {
    if(!Hls.isSupported())throw new Error('В этом браузере недоступен HLS-плеер.');
    engine=new Hls({maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:20,maxBufferSize:24*1024*1024,startPosition:start || -1});
    engine.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal && ticket===generation){console.warn('HLS playback failure',data.type,data.details,data.error?.message);onError('Поток AniLiberty недоступен. Попробуй другое качество или повтори запуск.');stopHls();video.pause();}});
    await new Promise(resolve=>{engine.once(Hls.Events.MEDIA_ATTACHED,()=>{if(ticket===generation)engine.loadSource(url);resolve();});engine.attachMedia(video);});
    if(ticket!==generation)return;
  }
  await video.play().catch(error=>{if(ticket===generation && error.name==='NotAllowedError')onError('Нажми ▶ на видео, чтобы начать просмотр.');});
}
