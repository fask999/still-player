'use strict';

// Offline planning by default. No service/app is started by this tool.
// Live reads and writes require separate, explicit CLI modes and reviewed IDs.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {COLUMNS, trackFromColumns, normalizeOutputs, normalizeOrders} = require('../src/main/foobar');
const executeFile = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EVIDENCE = path.join(ROOT, 'scripts', 'foobar-evidence', 'acceptance-1793332902113');
const DEFAULT_BACKEND = path.join(ROOT, 'dist', 'Still-V2-preview-win32-x64', 'backend', 'foobar2000');
const BASE_URL = 'http://127.0.0.1:18880/api/';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(JSON.stringify(value));
const canonical = value => path.win32.normalize(value).toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ID = /^[A-Za-z0-9_-]{1,200}$/;
function demand(condition, message, code = 'RESTORE_REFUSED') {if (!condition) throw Object.assign(new Error(message), {code});}
function location(value) {
  demand(typeof value?.path === 'string' && path.win32.isAbsolute(value.path) && !/[\0\r\n]/.test(value.path), 'An exact absolute track path is required.');
  demand(Number.isSafeInteger(value.subsong) && value.subsong >= 0, 'An explicit nonnegative subsong is required.');
  return {path: value.path, subsong: value.subsong};
}
const sameLocation = (a, b) => !!a && !!b && canonical(a.path) === canonical(b.path) && a.subsong === b.subsong;
// Preserve literal snapshot paths in this fingerprint; do not silently alter a deck.
const orderedFingerprint = items => digest(items.map(location));
const ownedTitle = title => /^STILL · (?:Playback .+|Queue sources) \[[0-9a-f-]{36}\]$/i.test(title || '');

function buildPlan({result, playlists, resultHash, playlistsHash, backend, allowCreateDeck = false} = {}) {
  const initial = result?.initialUserState, state = initial?.state, raw = initial?.rawPlayer, ref = raw?.activeItem;
  demand(state?.state === 'paused' && raw?.playbackState === 'paused' && state.controlUncertain === false, 'The saved source is not a verified paused session.');
  demand(Array.isArray(initial.queue?.items) && initial.queue.items.length === 0, 'The saved queue must be explicitly empty.');
  demand(Array.isArray(playlists?.playlists) && typeof ref?.playlistId === 'string' && Number.isSafeInteger(ref.index), 'Missing original playlist context.');
  const matching = playlists.playlists.filter(item => item.id === ref.playlistId);
  demand(matching.length === 1, 'The historical reference is not unique in its original snapshot.');
  const deck = matching[0], items = deck.items?.map(location), target = location(state.currentTrack);
  demand(typeof deck.name === 'string' && deck.name && items?.length && ref.index >= 0 && ref.index < items.length, 'Invalid saved complete playlist.');
  demand(deck.items.every(item => item.supported === true), 'The saved playlist contains unsupported/unknown locations.');
  demand(sameLocation(items[ref.index], target) && sameLocation(trackFromColumns(ref.columns), target), 'Saved path/subsong does not agree with the original occurrence.');
  demand(Number.isFinite(state.position) && state.position >= 0 && state.position < state.duration && Math.abs(ref.position - state.position) < 0.001, 'Invalid saved paused position.');
  demand(state.volumeInfo?.type === 'db' && state.volumeInfo.value === 0 && state.volumeInfo.isMuted === false, 'Saved volume is not the expected unmuted 0 dB.');
  demand(state.playbackOrder?.id === 0 && normalizeOrders(raw).playbackOrder?.id === 0, 'Saved playback order is not default order 0.');
  demand(typeof state.output?.id === 'string' && state.output.id === JSON.stringify([state.output.typeId, state.output.deviceId]), 'Saved exact output identity is missing.');
  if (allowCreateDeck) demand(ownedTitle(deck.name) && items.every(item => item.subsong === 0), 'Fallback is limited to this verified STILL-owned, all-subsong-zero deck.');
  const payload = {
    schemaVersion: 1, purpose: 'restore-exact-old-paused-session', baseUrl: BASE_URL,
    source: {resultHash, playlistsHash, oldPid: 23400, oldProcessEnded: true, historicalPlaylistId: ref.playlistId, historicalIdIsNotReusable: true},
    backend,
    target: {...target, title: state.currentTrack.title, position: state.position, state: 'paused', duration: state.duration,
      output: {id: state.output.id, typeId: state.output.typeId, deviceId: state.output.deviceId},
      volume: {type: 'db', value: 0, isMuted: false}, playbackOrder: 0, queue: []},
    playlist: {name: deck.name, items, count: items.length, orderedPathSubsongSha256: orderedFingerprint(items),
      targetIndex: ref.index, targetOccurrence: items.slice(0, ref.index + 1).filter(item => sameLocation(item, target)).length,
      targetOccurrences: items.filter(item => sameLocation(item, target)).length},
    fallback: {allowCreateDeck: allowCreateDeck, explicitExecuteFlagRequired: true, fullSequenceOnly: true,
      titlePattern: 'STILL · Playback Restore <timestamp> <uuid> [<uuid>]', changesOriginalPlaylists: false},
    constraints: {exclusiveQuietWindowRequired: true, noAtomicCompareAndSet: true, noConfigWrites: true,
      noQueueWrites: true, noFormalLibraryWrites: true, noAppStartup: true, uncertainPostNeverRetried: true}
  };
  return {planId: digest(payload), payload};
}
function validatePlan(plan, approvedId) {
  demand(plan?.payload?.schemaVersion === 1 && digest(plan.payload) === plan.planId && approvedId === plan.planId, 'The exact reviewed plan ID is required.');
  const p = plan.payload;
  demand(p.baseUrl === BASE_URL && p.playlist.count === p.playlist.items.length && orderedFingerprint(p.playlist.items) === p.playlist.orderedPathSubsongSha256 &&
    sameLocation(p.playlist.items[p.playlist.targetIndex], p.target), 'Plan target or full ordered fingerprint is invalid.');
  return p;
}

async function regularInside(root, relative) {
  demand(typeof relative === 'string' && relative && !relative.includes('\\') && !relative.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe manifest path.');
  let file = root;
  for (const segment of relative.split('/')) {file = path.join(file, segment); demand(!(await fs.lstat(file)).isSymbolicLink(), 'Refusing a linked backend file.');}
  demand((await fs.stat(file)).isFile(), 'Backend entry is not a regular file.'); return file;
}
async function backendIdentity(backendDir) {
  backendDir = path.resolve(backendDir);
  demand(canonical(await fs.realpath(backendDir)) === canonical(backendDir), 'Backend directory cannot be a link/junction.');
  const manifestFile = await regularInside(backendDir, 'backend-manifest.json'), raw = await fs.readFile(manifestFile);
  const manifest = JSON.parse(raw);
  demand(manifest.schemaVersion === 1 && manifest.privateUseOnly === true && manifest.dryRun === false && manifest.executable === 'foobar2000.exe' &&
    typeof manifest.backendId === 'string' && manifest.sourceDir && canonical(manifest.sourceDir) !== canonical(backendDir) &&
    canonical(manifest.destinationDir) === canonical(backendDir) && Array.isArray(manifest.files), 'Not the exact private backend manifest.');
  for (const required of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    demand(manifest.files.filter(item => item.relativePath === required && item.mutable === false).length === 1, `Required immutable manifest entry is missing/duplicated: ${required}`);
  }
  const seen = new Set();
  for (const item of manifest.files) {
    demand(!seen.has(item.relativePath), 'Duplicate manifest entry.'); seen.add(item.relativePath);
    const file = await regularInside(backendDir, item.relativePath);
    demand(typeof item.mutable === 'boolean' && /^[a-f0-9]{64}$/i.test(item.sha256), 'Invalid immutable-file manifest.');
    if (!item.mutable) demand(sha256(await fs.readFile(file)) === item.sha256.toLowerCase(), `Backend immutable hash mismatch: ${item.relativePath}`);
  }
  const configRaw = await fs.readFile(await regularInside(backendDir, 'profile/beefweb/config.json')), config = JSON.parse(configRaw);
  demand(config.port === 18880 && manifest.configuration?.port === 18880 && config.allowRemote === false &&
    manifest.configuration.allowRemote === false && Array.isArray(config.musicDirs) && config.musicDirs.length > 0, 'Only the manifest-verified loopback port 18880 is allowed.');
  const executable = path.join(backendDir, 'foobar2000.exe');
  const libraryFile = path.resolve(backendDir, '..', '..', 'data', 'library.json');
  return {backendDir, backendId: manifest.backendId, executable, manifestSha256: sha256(raw), configSha256: sha256(configRaw),
    executableSha256: sha256(await fs.readFile(executable)), libraryFile};
}
async function libraryHash(file) {
  demand(!(await fs.lstat(file)).isSymbolicLink() && (await fs.stat(file)).isFile(), 'The formal library must be an existing regular file.');
  demand(canonical(await fs.realpath(file)) === canonical(path.resolve(file)), 'Formal library cannot be a linked path.');
  return sha256(await fs.readFile(file));
}
async function inspectSystem(identity) {
  demand(process.platform === 'win32', 'Live inspection requires Windows.');
  const escaped = identity.executable.replace(/'/g, "''");
  const script = `$p=@(Get-CimInstance Win32_Process -Filter "Name='foobar2000.exe'" -ErrorAction Stop | Where-Object {$_.ExecutablePath -eq '${escaped}'} | ForEach-Object {@{pid=$_.ProcessId;executable=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')}}); $l=@(Get-NetTCPConnection -LocalPort 18880 -State Listen -ErrorAction Stop | ForEach-Object {@{pid=$_.OwningProcess;address=$_.LocalAddress}}); @{processes=$p;listeners=$l}|ConvertTo-Json -Depth 4 -Compress`;
  const {stdout} = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: 5000});
  return sessionIdentity(JSON.parse(stdout), identity);
}
function sessionIdentity(system, identity) {
  demand(Array.isArray(system?.processes) && system.processes.length === 1 && Array.isArray(system.listeners) && system.listeners.length > 0, 'Require one exact running backend and its listener.');
  const proc = system.processes[0];
  demand(Number.isSafeInteger(proc.pid) && proc.pid > 0 && proc.pid !== 23400 && typeof proc.createdAt === 'string' && Number.isFinite(Date.parse(proc.createdAt)) &&
    canonical(proc.executable) === canonical(identity.executable) && system.listeners.every(item => item.pid === proc.pid && ['127.0.0.1', '::1'].includes(item.address)), 'Backend PID, creation time, executable or loopback ownership is unverified.');
  return {pid: proc.pid, createdAt: proc.createdAt, executable: proc.executable};
}
function createTransport(fetcher = globalThis.fetch) {
  return async (route, body) => {
    demand(typeof route === 'string' && !/[#\\]/.test(route) && !/^[^/?]*:/.test(route) && !route.startsWith('/') && !route.split('?')[0].split('/').includes('..'), 'Invalid fixed restoration route.');
    const mutation = body !== undefined;
    demand(!mutation || /^player(?:\/pause|\/play\/[A-Za-z0-9_-]+\/\d+)?$/.test(route) || route === 'playlists/add' || /^playlists\/[A-Za-z0-9_-]+\/items\/add$/.test(route), 'Restoration cannot write this route.');
    // Never abort/retry a dispatched POST and pretend its commit was revoked.
    const actual = (async () => {
      const response = await fetcher(new URL(route, BASE_URL), {method: mutation ? 'POST' : 'GET', redirect: 'error',
        headers: mutation ? {'Content-Type': 'application/json'} : {}, body: mutation ? JSON.stringify(body) : undefined,
        ...(mutation ? {} : {signal: AbortSignal.timeout(5000)})});
      const raw = await response.text(); demand(response.ok, `Restoration HTTP ${response.status}.`, mutation ? 'RESTORE_POST_UNCERTAIN' : 'RESTORE_READ_FAILED');
      return raw ? JSON.parse(raw) : null;
    })();
    if (!mutation) return actual;
    let timer;
    try {return await Promise.race([actual, new Promise((_resolve, reject) => {timer = setTimeout(() => reject(Object.assign(new Error('Dispatched restoration POST has uncertain settlement; no retry or success claim.'), {code: 'RESTORE_POST_UNCERTAIN'})), 5000);})]);}
    catch (error) {throw Object.assign(new Error('Restoration POST failed or is uncertain; no retry was sent.'), {code: 'RESTORE_POST_UNCERTAIN', cause: error});}
    finally {clearTimeout(timer);}
  };
}
async function readPlaylists(request) {
  const list = (await request('playlists'))?.playlists;
  demand(Array.isArray(list) && list.length <= 10000 && new Set(list.map(p => p.id)).size === list.length, 'Invalid complete playlist list.');
  const result = [];
  for (const p of list) {
    demand(ID.test(p.id) && typeof p.title === 'string' && Number.isSafeInteger(p.itemCount) && p.itemCount >= 0 && p.itemCount <= 100000, 'Invalid playlist metadata.');
    const items = []; let total = p.itemCount;
    for (let offset = 0; offset < total;) {
      const page = (await request(`playlists/${encodeURIComponent(p.id)}/items/${offset}:500?columns=${encodeURIComponent(COLUMNS.join(','))}`))?.playlistItems;
      demand(page?.offset === offset && page.totalCount === total && Array.isArray(page.items) && page.items.length > 0 && page.items.length <= 500 && offset + page.items.length <= total, 'Playlist changed or its complete page is unknown.');
      items.push(...page.items.map(row => location(trackFromColumns(row.columns)))); offset += page.items.length;
    }
    result.push({id: p.id, name: p.title, items});
  }
  const after = (await request('playlists'))?.playlists;
  demand(digest(after) === digest(list), 'Playlist list changed during inspection.');
  return result;
}
function playerSnapshot(raw, outputs) {
  demand(raw?.info?.name === 'foobar2000' && /^0\.10(?:\D|$)/.test(raw.info.pluginVersion || '') && ['playing', 'paused', 'stopped'].includes(raw.playbackState), 'Unverified Beefweb player.');
  const active = raw.activeItem, hasPath = typeof active?.columns?.[0] === 'string' && !!active.columns[0];
  const output = normalizeOutputs(outputs).selected;
  demand(output && output.unavailableInList !== true && typeof raw.volume?.isMuted === 'boolean' && Number.isFinite(raw.volume.value) && Number.isFinite(raw.volume.min) && Number.isFinite(raw.volume.max), 'Unknown output/volume state.');
  const order = normalizeOrders(raw).playbackOrder;
  demand(order && typeof order.id === 'number', 'Unknown playback order.');
  return {state: raw.playbackState, active: hasPath ? {...location(trackFromColumns(active.columns)), playlistId: active.playlistId, index: active.index, position: active.position} : null,
    volume: {type: raw.volume.type, value: raw.volume.value, isMuted: raw.volume.isMuted},
    order: order.id, output: {id: output.id, typeId: output.typeId, deviceId: output.deviceId}};
}
async function capture({request, session, libraryHash: readLibrary}) {
  const before = await session(), first = await request(`query?player=true&outputs=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`);
  const player = playerSnapshot(first?.player, first?.outputs);
  const queue = (await request('playqueue'))?.playQueue;
  demand(Array.isArray(queue) && queue.length === 0, 'Current queue is nonempty or unknown; it is preserved.');
  const playlists = await readPlaylists(request), last = await request(`query?player=true&outputs=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`);
  demand(digest(playerSnapshot(last?.player, last?.outputs)) === digest(player), 'Player/configuration changed while capturing state.');
  const after = await session(); demand(digest(before) === digest(after), 'Backend process session changed.');
  return {session: after, player, queue: [], playlists, formalLibrarySha256: await readLibrary()};
}
function exactMatch(p, playlists) {
  const matches = playlists.filter(deck => deck.name === p.playlist.name && deck.items.length === p.playlist.count && orderedFingerprint(deck.items) === p.playlist.orderedPathSubsongSha256);
  demand(matches.length <= 1, 'More than one exact original playlist matches; restoration is ambiguous.');
  const deck = matches[0];
  if (deck) demand(sameLocation(deck.items[p.playlist.targetIndex], p.target), 'The exact target occurrence is missing.');
  return deck || null;
}
function configMatches(p, player) {
  demand(digest(player.output) === digest(p.target.output) && digest(player.volume) === digest(p.target.volume) && player.order === p.target.playbackOrder, 'Output, order or volume conflicts; no configuration was changed.');
}
function alreadyPaused(p, player, deck) {
  return player.state === 'paused' && deck && player.active?.playlistId === deck.id && player.active.index === p.playlist.targetIndex &&
    sameLocation(player.active, p.target) && Number.isFinite(player.active.position) && Math.abs(player.active.position - p.target.position) < 0.05;
}
function preflight(p, snapshot, allowCreateDeck) {
  configMatches(p, snapshot.player); demand(snapshot.queue?.length === 0, 'Queue must remain known and empty.');
  const deck = exactMatch(p, snapshot.playlists);
  demand(snapshot.player.state === 'stopped' || alreadyPaused(p, snapshot.player, deck), 'New session is playing/paused elsewhere or unknown; it is preserved.');
  demand(deck || p.fallback.allowCreateDeck && allowCreateDeck === true, 'No unique exact playlist; no fallback was authorized.', 'RESTORE_CONTEXT_MISSING');
  return deck;
}
async function inspectCurrent(plan, {approvedPlanId, allowCreateDeck = false, ...deps}) {
  const p = validatePlan(plan, approvedPlanId), snapshot = await capture(deps);
  const deck = preflight(p, snapshot, allowCreateDeck);
  const payload = {schemaVersion: 1, planId: plan.planId, snapshot, action: deck ? alreadyPaused(p, snapshot.player, deck) ? 'already-restored' : 'reuse-exact-deck' : 'create-full-owned-deck'};
  return {baselineId: digest(payload), payload};
}
async function executeRestoration(plan, baseline, {approvedPlanId, approvedBaselineId, exclusiveWindowAck = false, allowCreateDeck = false,
  request, session, libraryHash: readLibrary, verifyFiles, sleep: wait = sleep, uuid = randomUUID, trace = []} = {}) {
  const p = validatePlan(plan, approvedPlanId);
  demand(exclusiveWindowAck === true, 'Explicit exclusive quiet-window acknowledgement is required; Beefweb has no compare-and-set.');
  demand(baseline?.payload?.planId === plan.planId && baseline.baselineId === approvedBaselineId && digest(baseline.payload) === baseline.baselineId, 'The newly inspected and reviewed session baseline ID is required.');
  const deps = {request, session, libraryHash: readLibrary};
  const initial = await capture(deps); demand(digest(initial) === digest(baseline.payload.snapshot), 'New user/session changes after inspection; nothing was overwritten.');
  let deck = preflight(p, initial, allowCreateDeck);
  await verifyFiles(p.playlist.items); // Every location, not only Rose, before any write.
  let expected = initial;
  async function unchanged() {const now = await capture(deps); demand(digest(now) === digest(expected), 'New user/session changes before mutation; nothing further was written.');}
  await unchanged();
  if (!deck) {
    demand(p.playlist.items.every(item => item.subsong === 0), 'Fallback cannot guess a nonzero subsong import.');
    const title = `STILL · Playback Restore ${new Date().toISOString()} ${uuid()} [${uuid()}]`;
    demand(ownedTitle(title), 'Restore deck is not covered by the production ownedByStill filter.');
    const created = await request('playlists/add', {title});
    demand(ID.test(created?.id) && !initial.playlists.some(item => item.id === created.id), 'A unique new owned restore deck ID was not confirmed.');
    trace.push({event: 'created-owned-deck', id: created.id, title});
    const createdSnapshot = await capture(deps);
    demand(digest({...createdSnapshot, playlists: createdSnapshot.playlists.filter(item => item.id !== created.id)}) === digest(initial), 'New user/session change during deck creation.');
    const empty = createdSnapshot.playlists.find(item => item.id === created.id);
    demand(empty?.name === title && empty.items.length === 0, 'New restore deck is not exactly empty.');
    expected = createdSnapshot; await unchanged();
    await request(`playlists/${created.id}/items/add`, {items: p.playlist.items.map(item => item.path)});
    let loaded;
    for (let attempt = 0; attempt < 100; attempt++) {
      loaded = await capture(deps);
      demand(digest({...loaded, playlists: loaded.playlists.filter(item => item.id !== created.id)}) === digest(initial), 'New user/session change while building restore deck.');
      deck = loaded.playlists.find(item => item.id === created.id);
      demand(deck?.name === title && deck.items.length <= p.playlist.count, 'Restore import expanded/changed the complete deck.');
      if (deck.items.length === p.playlist.count) break;
      await wait(40);
    }
    demand(deck?.items.length === p.playlist.count && orderedFingerprint(deck.items) === p.playlist.orderedPathSubsongSha256, 'Full restore deck path/subsong/order did not match; no track was played.');
    expected = loaded;
  }
  if (alreadyPaused(p, expected.player, deck)) return {restored: true, alreadyRestored: true, trace, snapshot: expected};
  await unchanged();
  trace.push({event: 'pre-play-reference', playlistId: deck.id, index: p.playlist.targetIndex, ...deck.items[p.playlist.targetIndex]});
  await request(`player/play/${deck.id}/${p.playlist.targetIndex}`, {});
  // Minimize the normal audio window: no progress polling or reads before pause.
  await request('player/pause', {});
  async function pausedRead(expectedPosition) {
    const now = await capture(deps); configMatches(p, now.player);
    demand(digest(now.session) === digest(initial.session) && now.formalLibrarySha256 === initial.formalLibrarySha256 && digest(now.playlists) === digest(expected.playlists), 'Process/library/list context changed during restoration.');
    demand(now.player.state === 'paused' && now.player.active?.playlistId === deck.id && now.player.active.index === p.playlist.targetIndex &&
      sameLocation(now.player.active, p.target), 'Pause did not confirm the actual target path/subsong/reference; no seek or automatic stop was sent.');
    demand(Number.isFinite(now.player.active.position) && (expectedPosition === undefined || Math.abs(now.player.active.position - expectedPosition) < 0.05), 'Paused position was not read back.');
    return now;
  }
  await pausedRead();
  await request('player', {position: p.target.position});
  const first = await pausedRead(p.target.position); await wait(500); const last = await pausedRead(p.target.position);
  demand(Math.abs(last.player.active.position - first.player.active.position) < 0.01, 'Paused position did not remain frozen.');
  trace.push({event: 'verified-paused-frozen', playlistId: deck.id, index: p.playlist.targetIndex, position: last.player.active.position});
  return {restored: true, createdOwnedDeck: !exactMatch(p, initial.playlists), snapshot: last, trace};
}

async function verifyLocations(items) {
  for (const item of items) {
    location(item);
    demand(['.flac', '.m4a', '.wav'].includes(path.win32.extname(item.path).toLowerCase()) && (await fs.stat(item.path)).isFile(), `A complete-deck location is missing/unsupported: ${item.path}`);
  }
}
async function loadLocalPlan({evidenceDir = DEFAULT_EVIDENCE, backendDir = DEFAULT_BACKEND, allowCreateDeck = false} = {}) {
  const [resultRaw, playlistsRaw, backend] = await Promise.all([fs.readFile(path.join(evidenceDir, 'result.json')), fs.readFile(path.join(evidenceDir, 'playlists-before.json')), backendIdentity(backendDir)]);
  return buildPlan({result: JSON.parse(resultRaw), playlists: JSON.parse(playlistsRaw), resultHash: sha256(resultRaw), playlistsHash: sha256(playlistsRaw), backend, allowCreateDeck});
}
function argsFor(argv) {
  const flags = new Set(['--inspect-current', '--execute', '--allow-create-restore-deck', '--exclusive-window-ack']);
  const values = new Set(['--evidence-dir', '--backend-dir', '--plan', '--baseline', '--approved-plan-id', '--approved-baseline-id', '--out']);
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; demand(flags.has(key) || values.has(key), `Unknown argument ${key}.`); demand(!(key in result), `Duplicate argument ${key}.`);
    if (flags.has(key)) result[key] = true;
    else {demand(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), `Missing value for ${key}.`); result[key] = argv[++i];}
  }
  demand(!(result['--inspect-current'] && result['--execute']), 'Select one mode.'); return result;
}
async function main(argv = process.argv.slice(2)) {
  const args = argsFor(argv), allowCreateDeck = args['--allow-create-restore-deck'] === true;
  const live = args['--inspect-current'] || args['--execute']; let report, trace = [], outputReserved = false;
  try {
    if (!live) report = await loadLocalPlan({evidenceDir: args['--evidence-dir'], backendDir: args['--backend-dir'], allowCreateDeck});
    else {
      demand(args['--plan'] && args['--out'], 'Live modes require an explicit reviewed plan and output artifact path.');
      await fs.writeFile(args['--out'], `${JSON.stringify({phase: args['--execute'] ? 'execute-requested' : 'inspect-requested', restored: false})}\n`, {flag: 'wx'});
      outputReserved = true;
      const plan = JSON.parse(await fs.readFile(args['--plan'], 'utf8')), p = validatePlan(plan, args['--approved-plan-id']);
      const identity = await backendIdentity(p.backend.backendDir);
      demand(digest(identity) === digest(p.backend), 'Backend manifest/config/executable changed after planning.');
      const session = async () => {
        demand(digest(await backendIdentity(identity.backendDir)) === digest(identity), 'Backend manifest/config/executable changed during restoration.');
        return inspectSystem(identity);
      };
      const readLibrary = () => libraryHash(identity.libraryFile), request = createTransport();
      const deps = {approvedPlanId: args['--approved-plan-id'], allowCreateDeck, request, session, libraryHash: readLibrary};
      if (args['--inspect-current']) report = await inspectCurrent(plan, deps);
      else {
        demand(args['--baseline'], 'Execute requires a freshly inspected baseline.');
        const baseline = JSON.parse(await fs.readFile(args['--baseline'], 'utf8'));
        report = await executeRestoration(plan, baseline, {...deps, approvedBaselineId: args['--approved-baseline-id'], exclusiveWindowAck: args['--exclusive-window-ack'] === true, verifyFiles: verifyLocations, trace});
      }
    }
  } catch (error) {
    report = {restored: false, failed: true, code: error.code || 'RESTORE_FAILED', message: error.message, trace,
      uncertainPost: error.code === 'RESTORE_POST_UNCERTAIN', automaticRetryOrStop: false};
    if (args['--out'] && outputReserved) await fs.writeFile(args['--out'], `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
  if (args['--out']) await fs.writeFile(args['--out'], `${JSON.stringify(report, null, 2)}\n`, {flag: outputReserved ? 'w' : 'wx'});
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (require.main === module) main().catch(error => {process.stderr.write(`${error.code || 'RESTORE_FAILED'}: ${error.message}\n`); process.exitCode = 1;});
module.exports = {buildPlan, validatePlan, orderedFingerprint, ownedTitle, backendIdentity, sessionIdentity, createTransport,
  capture, exactMatch, preflight, inspectCurrent, executeRestoration, loadLocalPlan, argsFor, main, BASE_URL};
