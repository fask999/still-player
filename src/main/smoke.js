'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {record, string, numeric} = require('./ipc-handlers');
function withSmokeLyricsFixture(handlers, {enabled, smokeMode, track} = {}) {
  if (!enabled) return handlers;
  if (!smokeMode) throw new Error('The lyric UI fixture is allowed only in read-only desktop smoke');
  if (!track?.id) throw new Error('The lyric UI fixture requires a real existing library track');
  const fixtureLabel = '测试歌词 / 非真实匹配';
  let revision = 0;
  const player = () => ({available: true, state: 'paused', source: 'local', lastSource: 'local',
    position: 17.8, duration: Math.max(track.duration || 0, 40), volume: null, currentTrackId: track.id,
    currentTrack: {...track}, generation: 0, revision: ++revision, simulatedUIFixture: true, fixtureLabel});
  const original = [
    ['这是一段测试歌词', 'These are words composed for this layout test.'],
    ['窗外的风慢慢经过', 'The wind passes slowly beyond the window.'],
    ['让每一行有自己的呼吸', 'Let every line have room to breathe.'],
    ['此刻只校验文字与时间', 'This moment checks words and timing only.'],
    ['原文与译文一起停留', 'Original words and translation remain together.'],
    ['没有真实音频正在播放', 'No real audio is playing in this test.'],
    ['灯光在安静的页面流动', 'Light moves across the quiet page.'],
    ['所有测试内容清楚标记', 'Every test item is explicitly marked.']
  ];
  const document = {trackId: track.id, status: 'ready', kind: 'word', source: 'smoke-fixture',
    title: track.title, artist: track.artist, offsetMs: 0, fromCache: false, local: false, bound: false,
    simulatedUIFixture: true, fixtureLabel, lines: original.map(([text, translation], index) => {
      const startMs = index * 5000, endMs = startMs + 4500, characters = Array.from(text);
      return {startMs, endMs, text, translation, words: characters.map((text, word) => ({text,
        startMs: startMs + Math.floor(word * 4500 / characters.length), endMs: startMs + Math.floor((word + 1) * 4500 / characters.length)}))};
    })};
  return {...handlers,
    'app:bootstrap': async p => ({...await handlers['app:bootstrap'](p), player: player(), simulatedUIFixture: true, fixtureLabel}),
    'player:state': async () => player(),
    'lyrics:resolve': async p => {if (p.trackId !== track.id) throw new Error('测试歌词仅适用于当前测试曲目。'); return structuredClone(document);},
    'lyrics:search': async () => ({results: [], source: 'smoke-fixture', status: 'not-found', simulatedUIFixture: true, fixtureLabel})};
}
const SMOKE_READ_CHANNELS = new Set(['app:bootstrap', 'app:restoreInfo', 'source:status', 'source:select', 'apple:status', 'apple:library', 'apple:search', 'library:list', 'player:state', 'player:context', 'player:spectrum', 'queue:list', 'audio:outputs', 'audio:details', 'settings:get', 'desktop:status', 'dac:list', 'lyrics:resolve', 'lyrics:search', 'lyrics:preview']);
const DEFAULT_SMOKE_PLAN = [
  {action: 'click', selector: '[data-view="library"]'},
  {action: 'assert', selector: '#pageTitle', text: '曲目库'}, {action: 'screenshot', name: '01-library'},
  {action: 'click', selector: '[data-view="albums"]'}, {action: 'assert', selector: '#pageTitle', text: '专辑'}, {action: 'screenshot', name: '02-albums'},
  {action: 'click', selector: '[data-view="artists"]'}, {action: 'screenshot', name: '03-artists'},
  {action: 'click', selector: '[data-view="playlists"]'}, {action: 'screenshot', name: '04-playlists'},
  {action: 'click', selector: '[data-view="library"]'}, {action: 'fill', selector: '#search', value: 'STILL smoke search'},
  {action: 'screenshot', name: '05-search'}, {action: 'fill', selector: '#search', value: ''},
  {action: 'click', selector: '#queueButton'}, {action: 'wait', ms: 1000}, {action: 'assert', selector: '#dialog[open]'},
  {action: 'screenshot', name: '06-queue'}, {action: 'click', selector: '#closeDialog'},
  {action: 'click', selector: '#audioButton'}, {action: 'wait', ms: 1500}, {action: 'assert', selector: '#dialog[open]'},
  {action: 'screenshot', name: '07-settings'}, {action: 'click', selector: '#closeDialog'},
  {action: 'click', selector: '#nowTitle', optional: true}, {action: 'wait', ms: 200}, {action: 'screenshot', name: '08-now-playing-entry'},
  {action: 'click', selector: '#leaveImmersive', optional: true},
  {action: 'resize', width: 980, height: 680}, {action: 'wait', ms: 200}, {action: 'screenshot', name: '09-narrow-window'}
];
function validateSmokePlan(plan) {
  if (!Array.isArray(plan) || plan.length > 100) throw new Error('Smoke plan must be an array of at most 100 steps');
  return plan.map(step => {
    record(step);
    if (!['click', 'fill', 'select', 'wait', 'assert', 'resize', 'screenshot'].includes(step.action)) throw new Error('Unknown smoke action');
    if (['click', 'fill', 'select', 'assert'].includes(step.action)) string(step.selector, 'smoke selector');
    if (['fill', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('Smoke value must be text');
    if (step.action === 'wait') numeric(step.ms, 0, 5000, 'smoke wait');
    if (step.action === 'resize') {
      for (const key of ['width', 'height']) if (!Number.isInteger(step[key]) || step[key] < 400 || step[key] > 3840) throw new Error('Invalid smoke window size');
    }
    if (step.action === 'screenshot' && (typeof step.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(step.name))) throw new Error('Invalid smoke screenshot name');
    if (step.text != null && typeof step.text !== 'string') throw new Error('Smoke assertion text must be text');
    if (step.optional != null && typeof step.optional !== 'boolean') throw new Error('Smoke optional flag must be boolean');
    if (step.allowBelowMinimum != null && (step.action !== 'resize' || typeof step.allowBelowMinimum !== 'boolean')) throw new Error('Smoke minimum override is allowed only as a resize boolean');
    return {...step};
  });
}
async function runDesktopSmoke({mainWindow, dataDir, version, getState, getActualState, simulatedUIFixture = false, diagnostics, plan = DEFAULT_SMOKE_PLAN}) {
  const productMinimumWindow = mainWindow.getMinimumSize();
  const report = {started: true, version, simulatedUIFixture, productMinimumWindow, sandbox: true, contextIsolation: true, readOnlyIPC: true, steps: [], screenshots: [], diagnostics};
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const execute = source => mainWindow.webContents.executeJavaScript(source);
  const capture = async name => {
    // DOM text can update before Chromium presents the corresponding frame.
    // Decode visible images and cross two animation frames before capturePage.
    const animationSettlement = await execute(`(async () => {
      await document.fonts.ready;
      await Promise.race([Promise.all([...document.images].map(image => image.decode?.().catch(() => {}))), new Promise(resolve => setTimeout(resolve, 1500))]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const finite = document.getAnimations().filter(animation => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === 'running' && timing && Number.isFinite(timing.endTime) && Number.isFinite(timing.iterations);
      });
      const timedOut = await Promise.race([Promise.allSettled(finite.map(animation => animation.finished)).then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 650))]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {finiteAnimations:finite.length,timedOut};
    })()`);
    await pause(150);
    await fs.writeFile(path.join(dataDir, `${name}.png`), (await mainWindow.webContents.capturePage()).toPNG());
    report.screenshots.push({name: `${name}.png`, animationSettlement, ...await execute(`(() => {
      const clip = document.getElementById('content')?.getBoundingClientRect();
      const visibleTrackRowRects = [...document.querySelectorAll('.track-row')].map(row => {
        const rect = row.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};
      }).filter(rect => clip && rect.width > 0 && rect.top >= Math.max(clip.top,0) && rect.bottom <= Math.min(clip.bottom,innerHeight));
      const play = document.querySelector('.detail-play'), playRect = play?.getBoundingClientRect();
      const detailPlay = playRect ? {disabled:play.disabled,top:playRect.top,bottom:playRect.bottom,height:playRect.height,
        visible:playRect.width>0 && playRect.top>=Math.max(clip?.top||0,0) && playRect.bottom<=Math.min(clip?.bottom||innerHeight,innerHeight)} : null;
      return {view:window.StillApp?.state.view,immersive:window.StillApp?.state.immersive,
      browseSource:window.StillApp?.state.browseSource,heading:document.querySelector('#pageTitle')?.textContent,
      dialog:document.querySelector('dialog[open] h2')?.textContent || null,width:innerWidth,height:innerHeight,devicePixelRatio,
      visibleTrackRows:visibleTrackRowRects.length,fullyVisibleRowCount:visibleTrackRowRects.length,visibleTrackRowRects,detailPlay,horizontalOverflow:document.documentElement.scrollWidth > innerWidth};
    })()`)});
  };
  try {
    const deadline = Date.now() + 15000;
    while (!await execute('Boolean(window.StillApp?.state.ready)')) {
      if (Date.now() > deadline) throw new Error('Renderer did not become ready within 15 seconds');
      await pause(100);
    }
    await execute('document.fonts.ready.then(() => true)');
    report.bridge = await execute(`(async () => {
      const result = await window.still.invoke('app:bootstrap');
      return {tracks:result.library.tracks.length,playlists:result.library.playlists.length,
        playerAvailable:result.player.available,simulatedUIFixture:result.simulatedUIFixture === true,version:result.version,
        nodeExposed:typeof window.require !== 'undefined',bridgeReady:typeof window.still.on === 'function'};
    })()`);
    if (report.bridge.nodeExposed || !report.bridge.bridgeReady) throw new Error('Renderer isolation or preload bridge failed');
    await capture('00-startup');
    const beforeBrowsing = await getState();
    const selectBrowseSource = async source => {
      await execute(`document.getElementById(${JSON.stringify(source === 'apple' ? 'sourceApple' : 'sourceLocal')}).click()`);
      const deadline = Date.now() + 5000;
      while (await execute(`window.StillApp.state.browseSource !== ${JSON.stringify(source)}`)) {
        if (Date.now() > deadline) throw new Error('Browsing source did not update');
        await pause(50);
      }
      const selected = await execute(`window.still.invoke('source:status')`);
      if (selected.selectedSource !== source) throw new Error('Browsing source IPC did not agree with the DOM');
    };
    await selectBrowseSource('apple'); await pause(100); await capture('00-apple-source');
    const whileAppleBrowsing = await getState();
    await selectBrowseSource('local'); await pause(100); await capture('00-local-source');
    const afterBrowsing = await getState();
    const playbackIdentity = state => JSON.stringify({generation: state.generation, source: state.source, state: state.state,
      currentTrackId: state.currentTrackId || null, path: state.currentTrack?.path || null, subsong: state.currentTrack?.subsong ?? null});
    report.sourceBrowsing = {before: beforeBrowsing, whileAppleBrowsing, after: afterBrowsing,
      unchanged: playbackIdentity(beforeBrowsing) === playbackIdentity(whileAppleBrowsing) && playbackIdentity(beforeBrowsing) === playbackIdentity(afterBrowsing),
      activePlaybackObserved: !simulatedUIFixture && beforeBrowsing.available === true && ['playing', 'paused'].includes(beforeBrowsing.state)};
    if (!report.sourceBrowsing.unchanged) throw new Error('Browsing source changed actual playback state or generation');
    for (const step of validateSmokePlan(plan)) {
      if (step.action === 'wait') await pause(step.ms);
      else if (step.action === 'resize') {
        if (step.allowBelowMinimum) {
          mainWindow.setMinimumSize(Math.min(productMinimumWindow[0], step.width), Math.min(productMinimumWindow[1], step.height));
          report.forcedBelowProductMinimum = step.width < productMinimumWindow[0] || step.height < productMinimumWindow[1];
        }
        mainWindow.setSize(step.width, step.height); await pause(150);
      }
      else if (step.action === 'screenshot') await capture(step.name);
      else {
        const outcome = await execute(`(() => {
          const step = ${JSON.stringify(step)};
          const element = document.querySelector(step.selector);
          if (!element) {if (step.optional) return 'missing'; throw new Error('Smoke element missing: ' + step.selector);}
          const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
          if (!bounds.width || !bounds.height || style.visibility === 'hidden' || style.display === 'none') {if (step.optional) return 'hidden'; throw new Error('Smoke element hidden: ' + step.selector);}
          if (step.action === 'click') {if (element.disabled) {if (step.optional) return 'disabled'; throw new Error('Smoke element disabled');} element.click();}
          if (step.action === 'fill' || step.action === 'select') {
            element.value = step.value;
            element.dispatchEvent(new Event(step.action === 'fill' ? 'input' : 'change', {bubbles:true}));
          }
          if (step.action === 'assert' && step.text != null && !element.textContent.includes(step.text)) throw new Error('Smoke text mismatch: ' + step.selector);
          return true;
        })()`);
        if (outcome !== true) {report.steps.push({...step, skipped: outcome}); continue;}
      }
      report.steps.push({...step, passed: true});
    }
    report.dom = await execute(`({title:document.title,ready:window.StillApp.state.ready,view:window.StillApp.state.view,
      heading:document.querySelector('h1')?.textContent,connection:document.getElementById('connectionText')?.textContent,
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
      horizontalOverflow:document.documentElement.scrollWidth > innerWidth,
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      missingImages:[...document.images].filter(image => image.complete && !image.naturalWidth).map(image => image.src)})`);
    report.player = await getState();
    if (getActualState) report.actualPlayer = await getActualState();
    await capture('desktop-smoke');
    report.passed = !diagnostics.some(item => item.level === 'error') && !report.dom.missingImages.length && !report.screenshots.some(item => item.horizontalOverflow);
  } catch (error) {report.error = error.message; report.passed = false; await capture('desktop-smoke-failed').catch(() => {});}
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
  return report;
}


module.exports = {withSmokeLyricsFixture, SMOKE_READ_CHANNELS, validateSmokePlan, runDesktopSmoke};
