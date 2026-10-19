import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNick,profileLibrary} from './site/profile.js';
test('Nickname profiles normalize names and explicitly use public library API without credentials',async()=>{
  assert.equal(normalizeNick('  Marin_1 '),'marin_1');
  for(const value of ['ab','../secret','name with space'])assert.throws(()=>normalizeNick(value));
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://158-180-61-121.sslip.io/dimovie-library/library');
    assert.equal(options.credentials,'omit');
    assert.deepEqual(JSON.parse(options.body),{nick:'test_nick',action:'get'});
    return new Response(JSON.stringify({nick:'test_nick',movies:[]}));
  };
  try{assert.deepEqual((await profileLibrary('TEST_NICK')).movies,[]);}finally{globalThis.fetch=original;}
});
