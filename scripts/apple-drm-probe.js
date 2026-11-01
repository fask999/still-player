'use strict';

// Standalone, read-only media capability probe. This does not launch Still,
// touch its profile, sign in, inspect tokens, fetch CDMs, or start playback.
// Run: node_modules/electron/dist/electron.exe scripts/apple-drm-probe.js
// Add --official-site to inspect the unauthenticated official site's title
// and capability results in an isolated, temporary Electron profile.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'still-apple-capability-'));
app.setName('Still Apple capability probe');
app.setPath('userData', path.join(profile, 'user-data'));
app.setPath('sessionData', path.join(profile, 'session-data'));
fs.mkdirSync(app.getPath('userData'), {recursive: true});
fs.mkdirSync(app.getPath('sessionData'), {recursive: true});

async function probeCapabilities() {
  const audio = document.createElement('audio');
  const mediaTypes = [
    'audio/mp4; codecs="mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
    'audio/webm; codecs="opus"',
    'audio/flac',
  ];
  const result = {
    origin: location.origin,
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    emeApi: typeof navigator.requestMediaKeySystemAccess === 'function',
    codecs: Object.fromEntries(mediaTypes.map(type => [type, {
      canPlayType: audio.canPlayType(type),
      mediaSource: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type),
    }])),
    keySystems: {},
  };
  if (!result.emeApi) return result;
  const configurations = [
    {label: 'aac-audio', initDataTypes: ['cenc'], audioCapabilities: [{contentType: mediaTypes[0]}]},
    {label: 'aac-avc', initDataTypes: ['cenc'], audioCapabilities: [{contentType: mediaTypes[0]}], videoCapabilities: [{contentType: mediaTypes[1]}]},
    {label: 'opus-webm', initDataTypes: ['webm'], audioCapabilities: [{contentType: mediaTypes[2]}]},
  ];
  for (const keySystem of ['com.widevine.alpha', 'com.microsoft.playready', 'com.microsoft.playready.recommendation', 'com.apple.fps', 'org.w3.clearkey']) {
    const outcomes = [];
    for (const {label, ...configuration} of configurations) {
      try {
        const access = await Promise.race([
          navigator.requestMediaKeySystemAccess(keySystem, [configuration]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Capability query timed out after 5000 ms')), 5000)),
        ]);
        outcomes.push({configuration: label, available: true, selectedConfiguration: access.getConfiguration()});
      } catch (error) {
        outcomes.push({configuration: label, available: false, error: {name: error.name, message: error.message}});
      }
    }
    result.keySystems[keySystem] = outcomes;
  }
  return result;
}

let server;
let window;
const result = {
  checkedAt: new Date().toISOString(),
  versions: {electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node},
  profile,
  authenticated: false,
  attemptedPlayback: false,
};

const watchdog = setTimeout(() => {
  result.fatal = 'Probe exceeded 90000 ms';
  console.log(JSON.stringify(result, null, 2));
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"});
    response.end('<!doctype html><title>Media capability probe</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({show: false, webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  result.loopback = await window.webContents.executeJavaScript(`(${probeCapabilities.toString()})()`);
  if (process.argv.includes('--official-site')) {
    try {
      await window.loadURL('https://music.apple.com/cn/new');
      result.officialSite = await window.webContents.executeJavaScript(`(async () => ({
        title: document.title,
        origin: location.origin,
        hasSignInControl: [...document.querySelectorAll('button,a')].some(node => /^(sign in|登录|登入)$/i.test(node.textContent.trim())),
        declaresUnsupportedBrowser: /unsupported browser|browser is not supported|浏览器不受支持|不受支持的浏览器/i.test(document.body?.innerText || ''),
        capabilities: await (${probeCapabilities.toString()})(),
      }))()`);
    } catch (error) {
      result.officialSite = {error: {name: error.name, message: error.message}};
    }
  }
  console.log(JSON.stringify(result, null, 2));
}).catch(error => {
  result.fatal = {name: error.name, message: error.message};
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  if (server) server.close();
  app.quit();
});
