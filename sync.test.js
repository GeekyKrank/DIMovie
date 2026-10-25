import test from 'node:test';
import assert from 'node:assert/strict';

test('Source timeline survives repeated switches, pause and buffered seeks without accumulating offsets', async () => {
  const old=globalThis.document;
  const video=Object.assign(new EventTarget(),{currentTime:75,duration:300,paused:false,src:'',loads:0,plays:0,buffered:{length:0},
    load(){this.loads++;this.currentTime=0;this.paused=true;},play(){this.plays++;this.paused=false;return Promise.resolve();}});
  globalThis.document={getElementById:()=>video};
  try {
    const t=await import('./site/transport.js?absolute-regression');
    t.configureTransport('https://example.test/watch/a',async()=>({audio_timeline:'source',duration:300,tracks:[{index:1},{index:2}]}));
    await t.serverAudioTracks();
    t.selectServerAudio(1);t.selectServerAudio(2);
    assert.equal(t.playbackTime(),75);
    assert.match(video.src,/audio-v2\/2\/75\.000$/);
    assert.equal(video.plays,0);
    video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.currentTime,75);assert.equal(video.plays,1);
    video.currentTime=78;
    t.selectServerAudio(1);video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(t.playbackTime(),78);
    const before=video.loads;
    video.buffered={length:1,start:()=>70,end:()=>120};
    t.seekPlayback(100);assert.equal(video.loads,before);assert.equal(t.playbackTime(),100);
    t.seekPlayback(NaN);assert.equal(t.playbackTime(),100);
    video.paused=true;t.seekPlayback(200);video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(t.playbackTime(),200);assert.equal(video.paused,true);
    t.originalAudio();video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.currentTime,200);assert.equal(video.paused,true);
  }finally{globalThis.document=old;}
});

test('Silent unsupported original audio is prepared automatically and concurrent probes are shared', async () => {
  const old=globalThis.document;let resolve,probes=0;
  const video=Object.assign(new EventTarget(),{currentTime:12,duration:200,paused:false,src:'',canPlayType:()=>'',load(){this.currentTime=0;this.paused=true;},play(){this.paused=false;return Promise.resolve();}});
  globalThis.document={getElementById:()=>video};
  try {
    const t=await import('./site/transport.js?automatic-audio-regression');
    t.configureTransport('https://example.test/watch/a',()=>{probes++;return new Promise(r=>resolve=r);});
    const auto=t.ensureCompatibleAudio(), menu=t.serverAudioTracks();
    resolve({audio_timeline:'source',duration:200,tracks:[{index:1,codec:'ac3',default:true,language:'en'},{index:2,codec:'ac3',language:'rus'}]});
    assert.equal(await auto,true);await menu;
    assert.equal(probes,1);assert.equal(t.selectedServerAudio(),2);
    video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.currentTime,12);assert.equal(video.paused,false);
    t.configureTransport('https://example.test/watch/b',async()=>({tracks:[{index:1,codec:'aac'}]}));
    assert.equal(await t.ensureCompatibleAudio(),false);
  }finally{globalThis.document=old;}
});
