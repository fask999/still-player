'use strict';

const path = require('node:path');
const {createCueReadLease, isVerifiedCueReadLease} = require('./cue-read-lease');
const {isVerifiedBackendSession, isVerifiedBackendTreeExit} = require('./backend');
const {isExistingContextScopeForOperation} = require('./existing-context-scope');

const LIMITS = Object.freeze({holders: 8, operations: 16, prepareMs: 20000, shutdownMs: 12000});
const fail = (code, message) => Object.assign(new Error(message), {code});
const cancelled = () => fail('STILL_CANCELLED', 'CUE 播放准备已被新的操作取消。');
const uncertain = () => fail('STILL_CUE_PLAYBACK_CLEANUP_UNVERIFIED', 'CUE 读取租约或内核退出尚未核验。请正常退出 STILL 后重新打开。');
const changed = () => fail('STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED', 'CUE 或引用文件已改变，请刷新或重新导入后重试。');
function own(value, key) {return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;}
function snapshotLocations(values) {
  if (!Array.isArray(values) || values.length > 50000) throw changed();
  return Object.freeze(Array.from({length: values.length}, (_, index) => {
    const row = own(values, String(index)), file = own(row, 'path'), subsong = own(row, 'subsong');
    if (typeof file !== 'string' || !path.isAbsolute(file) || !Number.isSafeInteger(subsong) || subsong < 0) throw changed();
    return Object.freeze({path: file, subsong});
  }));
}
function snapshotRequests(values) {
  if (!Array.isArray(values) || values.length > LIMITS.holders) throw fail('STILL_CUE_PLAYBACK_LIMIT', '一次最多核验 8 个不同 CUE；请缩小所选列表。');
  const names = ['path', 'references', 'trackCount', 'authorizationRoot', 'encoding', 'contentHash'];
  const seen = new Set();
  return Array.from({length: values.length}, (_, index) => {
    const value = own(values, String(index));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== names.length ||
        !names.every(name => Object.hasOwn(value, name))) throw changed();
    const row = Object.fromEntries(names.map(name => [name, own(value, name)]));
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path) || typeof row.authorizationRoot !== 'string' || !path.isAbsolute(row.authorizationRoot) ||
        !Array.isArray(row.references) || !row.references.length || row.references.length > 32 ||
        !Number.isSafeInteger(row.trackCount) || row.trackCount < 1 || row.trackCount > 99 ||
        !['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(row.encoding) || typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.contentHash)) throw changed();
    row.references = Object.freeze(Array.from({length: row.references.length}, (_, index) => {
      const file = own(row.references, String(index)); if (typeof file !== 'string' || !path.isAbsolute(file)) throw changed(); return file;
    }));
    if (seen.has(row.path)) throw changed(); seen.add(row.path); return Object.freeze(row);
  });
}
const requestKey = value => JSON.stringify([value.path, value.references, value.trackCount, value.authorizationRoot, value.encoding, value.contentHash]);
const batchKey = values => JSON.stringify(values.map(requestKey).sort());
function bounded(work, milliseconds, timeout) {
  let timer;
  return Promise.race([work, new Promise((_resolve, reject) => {timer = setTimeout(() => reject(timeout()), milliseconds); timer.unref?.();})]).finally(() => clearTimeout(timer));
}

// Construction is passive. The Native module and backend's private brands are
// the authority; this production factory exposes no lease/brand injection seam.
function createCuePlaybackGuard({runtimeRoot, getRequests, getTreeExitEvidence, onTreeExit, onError = () => {}} = {}) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot) || typeof getRequests !== 'function') throw new TypeError('A CUE playback guard requires a runtime root and the private library getter.');
  const entries = new Set(), active = new Set(), preparations = new Set();
  let shuttingDown = false, unsubscribe = null, preClose = Promise.resolve();
  function report(code) {try {onError({code});} catch {}}
  function checkContext(record) {
    if (shuttingDown || record.released || record.cancelled || record.context.signal?.aborted) throw cancelled();
    record.context.check();
    if (record.scope !== undefined && !isExistingContextScopeForOperation(record.scope, record.context, record.session)) throw changed();
  }
  function notifyLost(entry, error, normalExit = false) {
    if (!entry.lost) {
      entry.lost = error || fail('STILL_CUE_PLAYBACK_LEASE_LOST', 'CUE 读取租约已失效。请正常退出 STILL 后重新打开。');
      if (!normalExit) report('STILL_CUE_PLAYBACK_LEASE_LOST');
    }
    // Only controllers of operations which use this exact lease are touched.
    // A retired request never calls coordinator.cancelPending, stop or restart.
    for (const owner of entry.owners) {owner.cancelled = true; try {owner.cancel(entry.lost);} catch {}}
  }
  function hasTreeExit(entry, supplied) {
    let proof = supplied;
    if (!proof) {try {proof = getTreeExitEvidence?.(entry.session);} catch {return false;}}
    return isVerifiedBackendTreeExit(proof, entry.session);
  }
  async function closeEntry(entry) {
    if (!entries.has(entry)) return;
    if (entry.risk && !hasTreeExit(entry, entry.treeProof)) throw uncertain();
    if (entry.closing) return entry.closing;
    if (!entry.lease && !entry.cleanup) {if (entry.acquiring) return; entries.delete(entry); return;}
    entry.closing = Promise.resolve().then(() => (entry.lease || entry.cleanup).close()).then(() => {
      entries.delete(entry); entry.closed = true;
    }).catch(error => {entry.cleanupUnverified = true; report('STILL_CUE_PLAYBACK_CLEANUP_UNVERIFIED'); throw error;}).finally(() => {entry.closing = null;});
    return entry.closing;
  }
  function observeTree(evidence, token) {
    if (!isVerifiedBackendTreeExit(evidence, token)) return;
    for (const entry of entries) if (entry.session === token) {
      entry.treeProof = evidence; notifyLost(entry, cancelled(), true);
      if (entry.acquiring) entry.controller.abort();
      else void closeEntry(entry).catch(() => {});
    }
  }
  function subscribe() {
    if (unsubscribe) return;
    if (typeof onTreeExit !== 'function' || typeof getTreeExitEvidence !== 'function') throw uncertain();
    const remove = onTreeExit(observeTree);
    if (typeof remove !== 'function') throw uncertain(); unsubscribe = remove;
  }
  function verifyLease(entry) {
    if (!entries.has(entry) || entry.closed || entry.closing || entry.lost || !isVerifiedCueReadLease(entry.lease, {request: entry.request})) throw entry.lost || uncertain();
    if (hasTreeExit(entry)) throw cancelled();
  }
  async function release(record) {
    if (record.released) return; record.released = true;
    record.context.signal?.removeEventListener('abort', record.abort);
    active.delete(record);
    const closing = [];
    for (const entry of record.entries) {
      entry.owners.delete(record);
      if (!entry.owners.size && !entry.risk && !entry.acquiring) closing.push(closeEntry(entry));
    }
    const results = await Promise.allSettled(closing);
    if (results.some(value => value.status === 'rejected')) throw uncertain();
  }
  async function requests(record) {
    checkContext(record);
    const result = await getRequests(record.locations, record.scope === undefined ? {} : {existingContextScope: record.scope});
    checkContext(record); return snapshotRequests(result);
  }
  async function acquire(record, request) {
    checkContext(record);
    const key = requestKey(request);
    let entry = [...entries].find(value => value.session === record.session && value.key === key);
    if (entry) {
      if (entry.acquiring) throw fail('STILL_CUE_PLAYBACK_BUSY', '相同 CUE 的读取租约仍在准备，请稍后重试。');
      verifyLease(entry); entry.owners.add(record); record.entries.add(entry); return;
    }
    if (entries.size >= LIMITS.holders) throw fail('STILL_CUE_PLAYBACK_LIMIT', '已保留 8 个 CUE 读取租约。请正常退出 STILL 后重新打开，再播放其他 CUE。');
    entry = {session: record.session, request, key, controller: new AbortController(), lease: null, cleanup: null,
      owners: new Set([record]), risk: false, acquiring: true, lost: null, closed: false, cleanupUnverified: false};
    entries.add(entry); record.entries.add(entry);
    try {
      if (hasTreeExit(entry)) throw cancelled();
      entry.lease = await createCueReadLease({runtimeRoot, request, signal: entry.controller.signal, onLost: () => notifyLost(entry)});
      entry.acquiring = false;
      checkContext(record); verifyLease(entry);
    } catch (error) {
      entry.acquiring = false;
      if (error?.cleanupPending && error.retainedController) {entry.cleanup = error.retainedController; entry.cleanupUnverified = true;}
      if (!entry.lease && !entry.cleanup) entries.delete(entry);
      throw error;
    }
  }
  function prepare({locations, context, session = null, existingContextScope, cancel} = {}) {
    if (!context || typeof context.check !== 'function' || typeof cancel !== 'function') return Promise.reject(new TypeError('A private cancellable operation is required.'));
    if (shuttingDown) return Promise.reject(cancelled());
    if (active.size >= LIMITS.operations) return Promise.reject(fail('STILL_CUE_PLAYBACK_LIMIT', 'CUE 播放核验操作过多，请等待当前准备结束。'));
    if ([...entries].some(entry => entry.cleanupUnverified || entry.lost && !entry.treeProof)) return Promise.reject(uncertain());
    let copy;
    try {copy = snapshotLocations(locations);} catch (error) {return Promise.reject(error);}
    const record = {context, session, scope: existingContextScope, locations: copy, entries: new Set(), cancel, cancelled: false, released: false, abort: null};
    record.abort = () => {
      record.cancelled = true;
      // An operation signal is never passed to an acquired/shared holder. It
      // may cancel acquisition, but cannot invalidate a replacement's lease.
      for (const entry of record.entries) if (entry.acquiring && entry.owners.size === 1) entry.controller.abort();
    };
    context.signal?.addEventListener('abort', record.abort, {once: true}); active.add(record);
    const work = (async () => {
      try {
        const first = await requests(record);
        if (first.length) {
          if (!isVerifiedBackendSession(session)) throw uncertain(); subscribe();
          await Promise.allSettled([...entries].filter(entry => entry.treeProof && entry.closing).map(entry => entry.closing));
          checkContext(record);
          if ([...entries].some(entry => entry.cleanupUnverified || entry.lost && !entry.treeProof)) throw uncertain();
          if (entries.size + first.filter(request => ![...entries].some(entry => entry.session === session && entry.key === requestKey(request))).length > LIMITS.holders) {
            throw fail('STILL_CUE_PLAYBACK_LIMIT', 'CUE 读取租约数量已达上限。请正常退出 STILL 后重新打开。');
          }
          for (const request of first) await acquire(record, request);
        }
        const check = () => {checkContext(record); for (const entry of record.entries) verifyLease(entry);};
        const recheck = async () => {
          check();
          for (const entry of record.entries) {await entry.lease.check(); check();}
          if (batchKey(await requests(record)) !== batchKey(first)) throw changed(); check();
        };
        const cuePaths = new Set(first.flatMap(value => [value.path, ...value.references]));
        const selected = new Set(record.locations.map(value => JSON.stringify([value.path, value.subsong])));
        const permit = Object.freeze({check, recheck, requiresExactLocation: location => cuePaths.has(location?.path),
          allowsReadback: location => selected.has(JSON.stringify([location?.path, location?.subsong])),
          async resolveIngestionPaths(missing) {
            check();
            // A scope allows verified playlist indices only. It never admits
            // an unknown file to the archive or to Beefweb's directory graph.
            if (record.scope !== undefined) throw changed();
            const known = new Set(first.map(requestKey));
            const paths = [];
            for (const location of snapshotLocations(missing)) {
              if (!selected.has(JSON.stringify([location.path, location.subsong]))) throw changed();
              if (!cuePaths.has(location.path)) {paths.push(location.path); continue;}
              // One file can carry both ordinary and CUE-associated tuples.
              // Resolve the exact tuple through the library under the locks.
              const rows = snapshotRequests(await getRequests([location], {})); check();
              if (rows.length > 1 || rows.some(row => !known.has(requestKey(row)))) throw changed();
              paths.push(rows[0]?.path || location.path);
            }
            await recheck(); return paths;
          },
          markNativeRead() {check(); for (const entry of record.entries) entry.risk = true;},
          release: () => release(record)
        });
        await permit.recheck(); permit.check(); return permit;
      } catch (error) {await release(record).catch(() => {}); throw error;}
    })();
    preparations.add(work); work.finally(() => preparations.delete(work)).catch(() => {});
    return bounded(work, LIMITS.prepareMs, () => {
      record.abort(); const error = fail('STILL_CUE_PLAYBACK_GUARD_TIMEOUT', 'CUE 播放核验超时；未继续新的原生读取。');
      try {cancel(error);} catch {} return error;
    });
  }
  function beginShutdown() {
    if (!shuttingDown) {
      shuttingDown = true;
      for (const record of active) {record.abort(); try {record.cancel(cancelled());} catch {}}
      preClose = Promise.allSettled([...entries].filter(entry => !entry.risk && !entry.acquiring).map(closeEntry));
    }
    return preClose;
  }
  async function close() {
    beginShutdown();
    await bounded(Promise.allSettled([preClose, ...preparations]), LIMITS.shutdownMs, uncertain);
    const results = await bounded(Promise.allSettled([...entries].map(entry => closeEntry(entry))), LIMITS.shutdownMs, uncertain);
    if (entries.size || results.some(value => value.status === 'rejected')) throw uncertain();
    if (unsubscribe) {unsubscribe(); unsubscribe = null;}
  }
  return Object.freeze({prepare, beginShutdown, close,
    getStatus: () => ({closed: shuttingDown, holders: entries.size, operations: active.size,
      retained: [...entries].filter(entry => entry.risk).length, uncertain: [...entries].filter(entry => entry.lost || entry.cleanupUnverified).length})});
}
module.exports = {createCuePlaybackGuard, CUE_PLAYBACK_GUARD_LIMITS: LIMITS};
