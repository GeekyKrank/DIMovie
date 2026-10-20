import test from 'node:test';
import assert from 'node:assert/strict';
import {historyItems, historyFor, saveHistory} from './site/history.js';

test('Viewing position survives reload, is isolated by profile, and preparation cannot overwrite it', () => {
  const old = globalThis.localStorage, data = new Map();
  globalThis.localStorage = {getItem:key=>data.get(key)||null, setItem:(key,value)=>data.set(key,value)};
  try {
    const movie={id:42,title:'Фильм'};
    saveHistory(movie, 75, 600);
    assert.equal(historyFor(movie).position,75);
    saveHistory(movie,0,0);
    assert.equal(historyFor(movie).position,75);
    saveHistory(movie,85,600);
    assert.equal(historyItems().length,1);
    assert.equal(historyFor(movie).position,85);
    localStorage.setItem('dimovie-profile','viewer');
    assert.equal(historyFor(movie),undefined);
    saveHistory(movie,125,600);
    assert.equal(historyFor(movie).position,125);
    localStorage.setItem('dimovie-profile','');
    assert.equal(historyFor(movie).position,85);
    saveHistory({animeId:42,title:'Аниме'},90,1200,'2');
    assert.equal(historyFor({animeId:42}).episode,'2');
    assert.equal(historyItems().length,2);
  } finally {globalThis.localStorage=old;}
});
