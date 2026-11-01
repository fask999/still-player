'use strict';

// Uses only the Microsoft WebView2 SDK supplied with --sdk-dir and the locally
// installed Evergreen runtime. Does not install a runtime, sign in, read tokens,
// alter the UA/security flags, or play media. All profiles and binaries are
// isolated in a new temporary directory. Requires Windows .NET Framework csc.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

// Only the documented, already-configured instance and named public members.
// Never enumerate the SDK object or access developerToken/musicUserToken.
async function probeOfficialPublicMethods(allowCatalogRead = false) {
  const started = Date.now();
  while (typeof window.MusicKit?.getInstance !== 'function' && Date.now() - started < 15000) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = {waitedMs: Date.now() - started, musicKitGlobal: typeof window.MusicKit,
    getInstance: typeof window.MusicKit?.getInstance, instanceAvailable: false,
    attemptedAuthorization: false, attemptedPlayback: false, attemptedAppleApiCalls: false};
  if (typeof window.MusicKit?.getInstance !== 'function') return result;
  let instance;
  try {instance = window.MusicKit.getInstance();}
  catch {result.instanceError = 'already-configured-instance-unavailable'; return result;}
  if (!instance) return result;
  result.instanceAvailable = true;
  result.methods = {
    authorize: typeof instance.authorize, unauthorize: typeof instance.unauthorize,
    play: typeof instance.play, pause: typeof instance.pause, stop: typeof instance.stop,
    skipToNextItem: typeof instance.skipToNextItem, skipToPreviousItem: typeof instance.skipToPreviousItem,
    seekToTime: typeof instance.seekToTime, setQueue: typeof instance.setQueue,
    playNext: typeof instance.playNext, playLater: typeof instance.playLater,
    apiMusic: typeof instance.api?.music, apiSearch: typeof instance.api?.search,
    apiLibrarySongs: typeof instance.api?.library?.songs,
  };
  result.publicState = {
    isAuthorized: typeof instance.isAuthorized === 'boolean' ? instance.isAuthorized : null,
    isPlaying: typeof instance.isPlaying === 'boolean' ? instance.isPlaying : null,
    playbackState: typeof instance.playbackState === 'number' || typeof instance.playbackState === 'string' ? instance.playbackState : null,
    currentPlaybackTime: Number.isFinite(instance.currentPlaybackTime) ? instance.currentPlaybackTime : null,
    currentPlaybackDuration: Number.isFinite(instance.currentPlaybackDuration) ? instance.currentPlaybackDuration : null,
    volume: Number.isFinite(instance.volume) ? instance.volume : null,
    queueItemsIsArray: Array.isArray(instance.queue?.items),
    queueLength: Array.isArray(instance.queue?.items) ? instance.queue.items.length : null,
  };
  const item = instance.nowPlayingItem;
  result.nowPlaying = item ? {id: typeof item.id === 'string' ? item.id.slice(0, 200) : null,
    title: typeof item.attributes?.name === 'string' ? item.attributes.name.slice(0, 500) : null,
    artist: typeof item.attributes?.artistName === 'string' ? item.attributes.artistName.slice(0, 500) : null,
    durationInMillis: Number.isFinite(item.attributes?.durationInMillis) ? item.attributes.durationInMillis : null} : null;
  if (allowCatalogRead && typeof instance.api?.music === 'function') {
    result.attemptedAppleApiCalls = true;
    try {
      const response = await Promise.race([
        instance.api.music('/v1/catalog/cn/search?term=Beethoven&types=songs&limit=1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('catalog-read-timeout')), 15000)),
      ]);
      const songs = response?.data?.results?.songs?.data;
      result.catalogRead = {operation: 'public-api.music/catalog-search', storefront: 'cn', succeeded: Array.isArray(songs),
        items: Array.isArray(songs) ? songs.slice(0, 1).map(song => ({id: typeof song.id === 'string' ? song.id.slice(0, 200) : null,
          title: typeof song.attributes?.name === 'string' ? song.attributes.name.slice(0, 500) : null,
          artist: typeof song.attributes?.artistName === 'string' ? song.attributes.artistName.slice(0, 500) : null,
          durationInMillis: Number.isFinite(song.attributes?.durationInMillis) ? song.attributes.durationInMillis : null})) : []};
    } catch (error) {result.catalogRead = {operation: 'public-api.music/catalog-search', succeeded: false, errorName: typeof error.name === 'string' ? error.name.slice(0, 80) : 'Error'};}
  }
  return result;
}

async function main() {
  const sdkDir = option('--sdk-dir');
  const outputDir = option('--output-dir');
  if (!sdkDir || !outputDir) throw new Error('Usage: node scripts/apple-webview2-probe.js --sdk-dir PATH --output-dir PATH');
  fs.mkdirSync(outputDir, {recursive: true});
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'still-apple-webview2-'));
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const coreDll = path.join(sdkDir, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll');
  const formsDll = path.join(sdkDir, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll');
  const loaderDll = path.join(sdkDir, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll');
  for (const file of [compiler, coreDll, formsDll, loaderDll]) {
    if (!fs.existsSync(file)) throw new Error(`Required local file missing: ${file}`);
  }
  for (const file of [coreDll, formsDll, loaderDll]) fs.copyFileSync(file, path.join(workDir, path.basename(file)));
  // Reuse the exact already-tested capability function, with explicit bounds.
  const electronProbe = fs.readFileSync(path.join(__dirname, 'apple-drm-probe.js'), 'utf8');
  const start = electronProbe.indexOf('async function probeCapabilities() {');
  const end = electronProbe.indexOf('\nlet server;', start);
  if (start < 0 || end < start) throw new Error('Could not locate shared capability function');
  const capabilityFunction = electronProbe.slice(start, end).trim();
  fs.writeFileSync(path.join(workDir, 'probe.js'), `(${capabilityFunction})()`);
  fs.writeFileSync(path.join(workDir, 'official-probe.js'), `(async () => ({
    title: document.title,
    origin: location.origin,
    hasSignInControl: [...document.querySelectorAll('button,a')].some(node => /^(sign in|登录|登入)$/i.test(node.textContent.trim())),
    declaresUnsupportedBrowser: /unsupported browser|browser is not supported|浏览器不受支持|不受支持的浏览器/i.test(document.body?.innerText || ''),
    capabilities: await (${capabilityFunction})(),
    publicMusicKit: await (${probeOfficialPublicMethods.toString()})(${process.argv.includes('--catalog-read')}),
  }))()`);
  const source = `using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class AppleMediaCapabilityProbe : Form {
  readonly WebView2 view = new WebView2();
  readonly string workDir;
  readonly string loopback;
  readonly Timer watchdog = new Timer();
  int step;
  AppleMediaCapabilityProbe(string workDir, string loopback) {
    this.workDir = workDir;
    this.loopback = loopback;
    Text = "Apple media capability probe";
    ShowInTaskbar = false;
    Opacity = 0;
    Location = new Point(-30000, -30000);
    StartPosition = FormStartPosition.Manual;
    Size = new Size(800, 600);
    view.Dock = DockStyle.Fill;
    Controls.Add(view);
    watchdog.Interval = 75000;
    watchdog.Tick += (sender, args) => Fail(new TimeoutException("Probe exceeded 75000 ms"));
    Shown += Initialize;
    FormClosed += (sender, args) => { watchdog.Stop(); view.Dispose(); };
  }
  void Fail(Exception error) {
    File.WriteAllText(Path.Combine(workDir, "fatal.txt"), error.ToString());
    Environment.ExitCode = 1;
    Close();
  }
  async void Initialize(object sender, EventArgs args) {
    try {
      watchdog.Start();
      var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(workDir, "isolated-profile"), null);
      await view.EnsureCoreWebView2Async(environment);
      File.WriteAllText(Path.Combine(workDir, "host-info.json"), new JavaScriptSerializer().Serialize(new {
        browserVersion = environment.BrowserVersionString,
        checkedAt = DateTime.UtcNow.ToString("o"),
        authenticated = false,
        attemptedPlayback = false,
        profile = Path.Combine(workDir, "isolated-profile")
      }));
      view.CoreWebView2.NewWindowRequested += (s, e) => { e.Handled = true; };
      view.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
      view.CoreWebView2.Navigate(loopback);
    } catch (Exception error) { Fail(error); }
  }
  async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args) {
    try {
      if (!args.IsSuccess) throw new Exception("Navigation failed: " + args.WebErrorStatus);
      string scriptName = step == 0 ? "probe.js" : "official-probe.js";
      // ExecuteScriptAsync returns a Promise as {}; use a WebMessageReceived
      // response so the async EME capability query is actually awaited.
      var completion = new System.Threading.Tasks.TaskCompletionSource<string>();
      EventHandler<CoreWebView2WebMessageReceivedEventArgs> handler = (s, e) => completion.TrySetResult(e.WebMessageAsJson);
      view.CoreWebView2.WebMessageReceived += handler;
      await view.CoreWebView2.ExecuteScriptAsync("Promise.resolve(" + File.ReadAllText(Path.Combine(workDir, scriptName)) + ").then(result => window.chrome.webview.postMessage(result)).catch(error => window.chrome.webview.postMessage({probeError:{name:error.name,message:error.message}}));");
      string result = await completion.Task;
      view.CoreWebView2.WebMessageReceived -= handler;
      File.WriteAllText(Path.Combine(workDir, step == 0 ? "loopback.json" : "official-site.json"), result);
      if (step++ == 0) view.CoreWebView2.Navigate("https://music.apple.com/cn/new");
      else Close();
    } catch (Exception error) { Fail(error); }
  }
  [STAThread] static void Main(string[] args) {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new AppleMediaCapabilityProbe(args[0], args[1]));
  }
}`;
  const sourceFile = path.join(workDir, 'AppleMediaCapabilityProbe.cs');
  const executable = path.join(workDir, 'AppleMediaCapabilityProbe.exe');
  fs.writeFileSync(sourceFile, source);
  const build = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`,
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    `/reference:${coreDll}`, `/reference:${formsDll}`, sourceFile], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  fs.writeFileSync(path.join(outputDir, 'compilation.log'), (build.stdout || '') + (build.stderr || ''));
  if (build.error || build.status !== 0) throw new Error(`Host compilation failed: ${build.error?.message || build.stdout || build.stderr}`);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"});
    response.end('<!doctype html><title>Media capability probe</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let hostStatus;
  try {
    hostStatus = await new Promise((resolve, reject) => {
      const child = spawn(executable, [workDir, `http://127.0.0.1:${server.address().port}/`], {windowsHide: true, stdio: 'ignore'});
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Native host exceeded 90000 ms')); }, 90000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
  } finally {
    server.close();
  }
  const readResult = name => {
    const file = path.join(workDir, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const result = {
    hostStatus, workDir,
    sdkVersion: '1.0.4258.31 (caller-supplied official SDK)',
    host: readResult('host-info.json'),
    loopback: readResult('loopback.json'),
    officialSite: readResult('official-site.json'),
    fatal: fs.existsSync(path.join(workDir, 'fatal.txt')) ? fs.readFileSync(path.join(workDir, 'fatal.txt'), 'utf8') : null,
  };
  fs.copyFileSync(sourceFile, path.join(outputDir, 'AppleMediaCapabilityProbe.cs'));
  fs.copyFileSync(path.join(workDir, 'official-probe.js'), path.join(outputDir, 'official-public-methods-probe.js'));
  fs.writeFileSync(path.join(outputDir, 'webview2-eme.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({hostStatus, workDir, output: path.resolve(outputDir, 'webview2-eme.json'), runtime: result.host?.browserVersion, fatal: result.fatal}));
  if (hostStatus !== 0 || result.fatal || !result.loopback || !result.officialSite) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
