'use strict';
// Local metadata only. No process/probe authority is created by this store.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
function handoffError(code, message, releaseEvidence) {
  return Object.assign(new Error(message), {code, ...(releaseEvidence ? {releaseEvidence} : {})});
}
function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length > 500 ||
      !Array.isArray(value.queue) || value.queue.length !== 0 || !value.output || typeof value.output.typeId !== 'string' ||
      typeof value.output.deviceId !== 'string' || typeof value.endpoint !== 'string' || !/^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(value.endpoint) || !value.volume ||
      !['db', 'linear'].includes(value.volume.type) || !['min', 'max', 'value'].every(key => Number.isFinite(value.volume[key])) ||
      value.volume.min >= value.volume.max || value.volume.value < value.volume.min || value.volume.value > value.volume.max ||
      !Number.isInteger(value.order) || value.order < 0) {
    throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '播放上下文、音量、顺序、输出或空队列未完整核验；保留内核，未退出。');
  }
  const mode = value.contextMode || 'active';
  if (mode === 'none') {
    if (value.playbackState !== 'stopped' || value.currentIndex !== null || value.playlistId !== null || value.playlistName !== null || value.items.length ||
        !Array.isArray(value.playlists) || value.playlists.length > 50 || value.playlists.reduce((sum, row) => sum + (Array.isArray(row?.items) ? row.items.length : 501), 0) > 500) {
      throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '无当前曲必须有 stopped、完整空队列和全部有界列表读回；未退出。');
    }
    for (const row of value.playlists) if (typeof row?.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(row.id) || typeof row.name !== 'string' || row.name.length > 1000 || !Array.isArray(row.items)) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '完整列表身份未核验。');
  } else if (mode !== 'active' || !value.items.length || !Number.isInteger(value.currentIndex) || value.currentIndex < 0 || value.currentIndex >= value.items.length ||
      typeof value.playlistId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value.playlistId) || typeof value.playlistName !== 'string' || value.playlistName.length > 1000) {
    throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前列表引用未完整核验；未退出。');
  }
  for (const items of mode === 'none' ? value.playlists.map(row => row.items) : [value.items]) {
  const counts = new Map();
  for (const row of items) {
    if (!row || typeof row.path !== 'string' || !path.win32.isAbsolute(row.path) || row.path.length > 32767 || /[\0\r\n]/.test(row.path) ||
        !Number.isSafeInteger(row.subsong) || row.subsong < 0) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '曲目路径或子曲身份未完整核验；未退出。');
    const key = `${row.path.replace(/\//g, '\\').toLowerCase()}\0${row.subsong}`, occurrence = counts.get(key) || 0;
    if (row.occurrence !== occurrence) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '重复曲目顺序未核验；未退出。');
    counts.set(key, occurrence + 1);
  }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw handoffError('STILL_HANDOFF_SNAPSHOT_TOO_LARGE', '播放上下文超过保存上限；未退出。');
  return value;
}
function contextIdentity(value) {
  validateSnapshot(value);
  return JSON.stringify({contextMode: value.contextMode || 'active', items: value.items, currentIndex: value.currentIndex, playlistName: value.playlistName,
    ...((value.contextMode || 'active') === 'none' ? {playlists: value.playlists.map(row => ({name: row.name, items: row.items}))} : {}),
    queue: value.queue, output: value.output, endpoint: value.endpoint, volume: value.volume, order: value.order});
}
function createOwnedOutputHandoffStore({dataDir} = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Handoff dataDir is required');
  const filename = path.join(dataDir, 'owned-output-handoff.json');
  let cached = null, writes = Promise.resolve();
  function serialize(action) {const work = writes.then(action); writes = work.catch(() => {}); return work;}
  async function safeTarget() {
    await fs.mkdir(dataDir, {recursive: true});
    const root = await fs.realpath(dataDir);
    if (path.resolve(root).toLowerCase() !== path.resolve(dataDir).toLowerCase()) throw handoffError('STILL_HANDOFF_STATE_PATH', '交接状态目录不能是链接。');
    const stat = await fs.lstat(filename).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw handoffError('STILL_HANDOFF_STATE_PATH', '交接状态文件不能是链接。');
  }
  async function writeRecord(value) {
    await safeTarget();
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {flag: 'wx'}); await safeTarget(); await fs.rename(temporary, filename);
      const stat = await fs.stat(filename);
      if (stat.size > MAX_BYTES + 4096 || JSON.stringify(JSON.parse(await fs.readFile(filename, 'utf8'))) !== JSON.stringify(value)) throw handoffError('STILL_HANDOFF_STATE_UNVERIFIED', '交接快照保存后回读不一致；未退出。');
    } finally {await fs.rm(temporary, {force: true}).catch(() => {});}
  }
  return {
    async initialize() {
      await safeTarget();
      const stat = await fs.stat(filename).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
      if (!stat) return {pending: false};
      if (stat.size > MAX_BYTES + 4096) throw handoffError('STILL_HANDOFF_STATE_UNVERIFIED', '交接状态超过上限，未自动启动本地内核。');
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (value.schemaVersion !== 1 || !['prepared', 'awaiting-local', 'restored', 'aborted'].includes(value.status) ||
          typeof value.sessionId !== 'string' || value.sessionId.length > 200 || typeof value.backendId !== 'string' || value.backendId.length > 200) throw handoffError('STILL_HANDOFF_STATE_UNVERIFIED', '交接状态格式未核验，未自动启动内核。');
      validateSnapshot(value.snapshot);
      cached = ['restored', 'aborted'].includes(value.status) ? null : value;
      return {pending: Boolean(cached), status: value.status};
    },
    save(snapshot, session) {return serialize(async () => {
      validateSnapshot(snapshot);
      if (!session || typeof session.sessionId !== 'string' || typeof session.backendId !== 'string') throw handoffError('STILL_HANDOFF_SESSION_UNVERIFIED', '未核验专属会话；未保存退出交接。');
      const value = {schemaVersion: 1, id: randomUUID(), status: 'prepared', sessionId: session.sessionId,
        backendId: session.backendId, snapshot: structuredClone(snapshot), recordedAt: new Date().toISOString()};
      await writeRecord(value);
      cached = value; return structuredClone(value);
    });},
    current: () => cached ? structuredClone(cached) : null,
    verify(snapshot) {
      if (!cached) return {verified: true, pending: false};
      if (contextIdentity(snapshot) !== contextIdentity(cached.snapshot)) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '专属内核当前列表、队列、音量、顺序或输出与交接快照不一致；未覆盖新变更或恢复旧曲。');
      return {verified: true, pending: true, currentPlaylistId: snapshot.playlistId, currentIndex: snapshot.currentIndex};
    },
    markExited(closedProfileFingerprint) {const owner = cached?.id; return serialize(async () => {if (cached && cached.id === owner) {const next = {...cached, status: 'awaiting-local', closedProfileFingerprint}; await writeRecord(next); cached = next;}});},
    clear() {const owner = cached?.id; return serialize(async () => {if (cached && cached.id === owner) {await writeRecord({...cached, status: 'restored'}); cached = null;}});},
    abandonPrepared(sessionId) {return serialize(async () => {if (cached?.status === 'prepared' && cached.sessionId === sessionId) {await writeRecord({...cached, status: 'aborted'}); cached = null;}});},
    filename
  };
}
module.exports = {createOwnedOutputHandoffStore, validateSnapshot, contextIdentity, handoffError};
