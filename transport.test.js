import test from 'node:test';
import assert from 'node:assert/strict';

test('Compatibility fallback uses one audio job, preserves raw network errors and ignores stale sources', async () => {
  const previous=globalThis.document;
  const video={currentTime:12,duration:200,paused:true,src:'',load(){},pause(){this.paused=true;},play:async()=>{},addEventListener(){},removeEventListener(){}};
  const status={textContent:''};
  globalThis.document={getElementById:id=>id==='embedded-video'?video:status};
  try {
    const transport=await import('./site/transport.js?compatibility-test');let probes=0;
    transport.configureTransport('https://example.test/watch/a',async()=>{probes++;return {duration:200,tracks:[{index:1,language:'en'},{index:2,language:'rus'}]};});
    assert.equal(await transport.recoverCompatiblePlayback(2),false);assert.equal(probes,0);
    assert.equal(await transport.recoverCompatiblePlayback(4),true);
    assert.match(video.src,/\/audio\/2\/12\.000$/);assert.equal(probes,1);
    assert.equal(await transport.recoverCompatiblePlayback(3),false);assert.equal(probes,1);
    transport.configureTransport('https://example.test/watch/xvid',async()=>({duration:200,video_codecs:['mpeg4'],tracks:[{index:1}]}));
    video.src='https://example.test/watch/xvid';
    await assert.rejects(transport.recoverCompatiblePlayback(4),/MPEG4/);
    assert.equal(video.src,'https://example.test/watch/xvid');
    let resolve;
    transport.configureTransport('https://example.test/watch/b',()=>new Promise(r=>{resolve=r;}));
    const pending=transport.recoverCompatiblePlayback(4);
    transport.configureTransport();resolve({duration:200,tracks:[{index:1}]});
    await assert.rejects(pending,/Источник изменился/);
    transport.configureTransport('https://example.test/watch/c',async()=>{throw new Error('занято');});
    await assert.rejects(transport.recoverCompatiblePlayback(4),/занято/);
    assert.equal(await transport.recoverCompatiblePlayback(4),false);
  } finally {globalThis.document=previous;}
});

test('Repeated audio switches retain movie time while the previous media is still unloading', async () => {
  const previous=globalThis.document, listeners=new Map();
  const video={currentTime:40,duration:200,paused:false,src:'',load(){},play:async()=>{},
    addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);}};
  globalThis.document={getElementById:()=>video};
  try {
    const transport=await import('./site/transport.js?switch-test');
    transport.configureTransport('https://example.test/video',async()=>({duration:200,tracks:[{index:1},{index:2}]}));
    await transport.serverAudioTracks();
    transport.selectServerAudio(1);
    assert.equal(transport.playbackTime(),40);
    transport.selectServerAudio(2);
    assert.match(video.src,/\/audio\/2\/40\.000$/);
    video.currentTime=0;listeners.get('loadedmetadata')();
    video.currentTime=3;
    assert.equal(transport.playbackTime(),43);
    transport.selectServerAudio(1);
    assert.match(video.src,/\/audio\/1\/43\.000$/);
    transport.selectServerAudio(2);
    assert.match(video.src,/\/audio\/2\/43\.000$/);
    transport.configureTransport();
    assert.equal(listeners.has('loadedmetadata'),false);
  } finally {globalThis.document=previous;}
});
