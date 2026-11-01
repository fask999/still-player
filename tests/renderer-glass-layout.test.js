'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {layoutMode} = require('../src/renderer/glass');
const root = path.join(__dirname, '../src/renderer');
const css = fs.readFileSync(path.join(root, 'room.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('portrait composition uses client dimensions and covers all requested tall windows including frame insets', () => {
  for (const [width, height] of [[464, 641], [480, 680], [480, 1000], [600, 1000], [768, 1280], [900, 1440], [980, 1280], [981, 1280], [1080, 1920], [1440, 2560], [1064, 1889], [1424, 2529]]) assert.equal(layoutMode(width, height), 'portrait', `${width}x${height}`);
  for (const [width, height] of [[1173, 601], [1440, 940], [1920, 1080], [2560, 1440], [900, 700]]) assert.equal(layoutMode(width, height), 'wide', `${width}x${height}`);
  assert.equal(layoutMode(671, 653), 'compact');
  assert.equal(layoutMode(0, 1000), 'wide');
  assert.equal(layoutMode(NaN, 1000), 'wide');
});

test('portrait rules allocate dedicated reading, source, navigation and two-row transport regions', () => {
  function rule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = [...css.matchAll(new RegExp(escaped + '\\s*\\{([^}]+)\\}', 'g'))];
    assert.ok(found.length, selector); return found.map(match => match[1]).join(' ');
  }
  assert.match(rule('body[data-layout=portrait] .app-shell'), /grid-template-columns:52px minmax\(0,1fr\)/);
  assert.match(rule('body[data-layout=portrait] .topbar'), /grid-template-rows:35px 38px/);
  assert.match(rule('body[data-layout=portrait] .navigation'), /overflow-x:auto/);
  assert.match(rule('body[data-layout=portrait] .immersive-art'), /minmax\(0,1fr\)/);
  assert.match(rule('body[data-layout=portrait] .immersive-body'), /flex-direction:column/);
  for (const selector of ['.listening-cabin', '.lyrics-column', '.lyrics-scroll', '.cabin-queue-body']) assert.match(rule('body[data-layout=portrait] ' + selector), /min-height:0/);
  for (const selector of ['.lyrics-scroll', '.cabin-queue-body', '.dialog-body']) assert.match(rule('body[data-layout=portrait] ' + selector), /overflow:auto/);
  assert.match(rule('body[data-layout=portrait] #playerFooter'), /grid-template-rows:36px 44px/);
  assert.match(rule('body[data-layout=portrait] .lyric-line'), /overflow-wrap:anywhere/);
  assert.match(rule('body[data-layout=portrait] .custom-accent'), /flex-wrap:wrap/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  const looping = [...css.matchAll(/animation:([^;}]*infinite[^;}]*)/g)].map(match => match[1]);
  assert.equal(looping.length, 0);
});

test('static portrait width budgets leave room for one seek group and persistent volume at 464 to 1440 CSS pixels', () => {
  // Static bounds, not browser geometry measurements. Values are checked against the
  // production declarations above; actual DPI/font/layout acceptance remains manual.
  assert.match(css, /#playerFooter \.transport \{ display:grid; grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(css, /body\[data-layout=portrait\] dialog \{ width:calc\(100vw - 28px\)/);
  for (const width of [464, 480, 600, 640, 768, 900, 1080, 1440]) {
    const narrow = width <= 540;
    const large = width >= 981, footerInner = width - (large ? 24 + 40 : 16 + 24) - 2;
    const buttons = 25 * 2 + (large ? 44 : 38) + 14;
    const waveWidth = footerInner - buttons - (large ? 22 : 14) - (large ? 72 : 56) - 12;
    assert.ok(waveWidth >= 230, `${width} native seek target`);
    assert.ok(footerInner - (large ? 126 : 94) - 12 >= 240, `${width} compact artwork/title region`);
    assert.ok((large ? 96 : 66) + 16 + 7 <= (large ? 126 : 94), `${width} volume control`);
    const dialogInner = width - 28 - 2 - 40;
    assert.ok(dialogInner >= 4 * 48 + 3 * 10, `${width} palette`);
    assert.ok(dialogInner >= 42 + 100 + 90 + 2 * 11, `${width} custom picker`);
    const libraryInner = width - 52 - (narrow ? 24 : 32);
    assert.ok(libraryInner >= 2 * 125 + 17, `${width} two-column archive`);
  }
});

test('listening tabs, all transport controls, and original semantic content IDs stay unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ['sourceLocal', 'sourceApple', 'sleeveNeighbors', 'listeningDeck', 'cabinLyrics', 'cabinQueue', 'lyricsColumn', 'lyricsScroll', 'cabinQueueBody', 'toggle', 'seek', 'volume', 'playbackOrder', 'audioButton', 'transport', 'playerCenter', 'waveSeek', 'settingsPlaybackControls']) assert.ok(ids.includes(id), id);
  for (const id of ['appearanceButton', 'recordStage', 'playerLyrics', 'playerQueue', 'playerAudio', 'immersiveTransport', 'cabinWave']) assert.ok(!ids.includes(id), id);
  assert.match(html, /id="cabinLyrics"[^>]+aria-pressed="true"/);
  assert.match(html, /id="cabinQueue"[^>]+aria-pressed="false"/);
  assert.doesNotMatch(html, /screen\.orientation|traffic-light|window-close|window-minimize|<audio\b/);
});

test('full-size portrait uses larger artwork and controls with a centered bounded reading cabin', () => {
  const large = css.slice(css.indexOf('@media(min-width:981px)'));
  assert.ok(large.startsWith('@media(min-width:981px)'));
  assert.match(large, /body\[data-layout=portrait\] \.app-shell\s*\{[^}]*grid-template-columns:76px minmax\(0,1fr\)/);
  assert.match(large, /body\[data-layout=portrait\] \.listening-sculpture\s*\{[^}]*width:clamp\(220px,46vw,330px\); aspect-ratio:1\.1/);
  assert.match(large, /body\[data-layout=portrait\] \.listening-cabin\s*\{[^}]*max-width:900px; align-self:center/);
  assert.match(large, /body\[data-layout=portrait\] \.immersive-art\s*\{ display:block;/);
  assert.match(large, /body\[data-layout=portrait\] \.play-button\s*\{[^}]*width:44px; height:44px/);
  assert.match(large, /body\[data-layout=portrait\] dialog\s*\{[^}]*width:min\(720px,calc\(100vw - 64px\)\)/);
  // Static bounds only: this does not assert native CSS geometry or monitor DPI.
  for (const width of [1064, 1080, 1424, 1440]) {
    const readingWidth = Math.min(900, Math.min(width - 76, 1080) - 80);
    assert.ok(readingWidth >= 800 && readingWidth <= 900, `${width} reading width`);
    assert.ok(width - 24 - 56 - 2 >= 250 + 350 + 24, `${width} transport columns`);
  }
});
