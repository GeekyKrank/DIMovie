import test from 'node:test';
import assert from 'node:assert/strict';
import {audioLabel,selectAudioTrack} from './site/audio.js';
test('Audio labels identify Ukrainian and preserve dubbing names',()=>{
 assert.equal(audioLabel({language:'uk-UA',label:'Studio'},0),'Українська · Studio');
 assert.equal(audioLabel({language:'rus'},1),'Русский');
 assert.equal(audioLabel({},2),'Дорожка 3');
});
test('Switching audio enables exactly one real track and rejects invalid selection',()=>{
 const tracks=[{enabled:true},{enabled:false},{enabled:false}];
 assert.equal(selectAudioTrack(tracks,1),true);
 assert.deepEqual(tracks.map(t=>t.enabled),[false,true,false]);
 assert.equal(selectAudioTrack(tracks,9),false);
 assert.deepEqual(tracks.map(t=>t.enabled),[false,true,false]);
});
