import test from 'node:test';
import assert from 'node:assert/strict';

test('Compatibility fallback uses one audio job, preserves raw network errors and ignores stale sources', async () => {
  const previous=globalThis.document;
  const video={currentTime:12,duration:200,paused:true,src:'',load(){},play:async()=>{},addEventListener(){}};
  const status={textContent:''};
  globalThis.document={getElementById:id=>id==='embedded-video'?video:status};
  try {
    const transport=await import('./site/transport.js?compatibility-test');let probes=0;
    transport.configureTransport('https://example.test/watch/a',async()=>{probes++;return {duration:200,tracks:[{index:1,language:'en'},{index:2,language:'rus'}]};});
    assert.equal(await transport.recoverCompatiblePlayback(2),false);assert.equal(probes,0);
    assert.equal(await transport.recoverCompatiblePlayback(4),true);
    assert.match(video.src,/\/audio\/2\/12\.000$/);assert.equal(probes,1);
    assert.equal(await transport.recoverCompatiblePlayback(3),false);assert.equal(probes,1);
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
