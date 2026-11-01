'use strict';

// Source policy (URLs, status handling, retries and byte limits) stays with the
// caller. maxQueued counts waiting work only, including work waiting for pacing.
// result is the logical deadline; settled is the complete physical lifetime.
function createBoundedSerialFetch({fetchImpl = globalThis.fetch, maxConcurrent = 1,
  maxQueued = 32, timeoutMs = 8000, minRequestIntervalMs = 0, intervalFrom = 'start', timeoutFrom = 'admission'} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch transport unavailable.');
  for (const [name, value, minimum] of [['maxConcurrent', maxConcurrent, 1], ['maxQueued', maxQueued, 0],
    ['timeoutMs', timeoutMs, 1], ['minRequestIntervalMs', minRequestIntervalMs, 0]]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid ${name}.`);
  }
  if (!['start', 'finish'].includes(intervalFrom)) throw new TypeError('Invalid pacing policy.');
  if (!['start', 'admission'].includes(timeoutFrom)) throw new TypeError('Invalid timeout policy.');
  const queue = [], active = new Set();
  let closed = false, nextStartAt = 0, pacingTimer;
  function failure(code) {return Object.assign(new Error(`Public request ${code.toLowerCase()}.`), {code, status: 'network-error'});}
  function finishLogical(job, error, value) {
    if (job.logicalDone) return;
    job.logicalDone = true; clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(value);
  }
  function detach(job) {clearTimeout(job.timer); job.externalSignal?.removeEventListener('abort', job.onAbort);}
  function stop(job, code) {
    if (!job.controller.signal.aborted) {job.error = failure(code); job.controller.abort(job.error);}
    finishLogical(job, job.error);
    const index = queue.indexOf(job);
    if (index >= 0) {queue.splice(index, 1); detach(job); job.resolveSettled(); drain();}
  }
  function context(job) {
    const pending = new Set(), records = new Set(), known = new WeakMap();
    let ended = false, previousResponse, fetchTail = Promise.resolve();
    const guard = () => {if (job.controller.signal.aborted) throw job.error;};
    function hold(value) {
      const promise = Promise.resolve(value);
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    }
    function cancel(record) {
      if (!record || record.cancellation) return record?.cancellation || Promise.resolve();
      record.cancellation = hold(Promise.resolve().then(() => {
        const target = record.reader && !record.released ? record.reader : record.body;
        return target?.cancel?.();
      }).catch(() => {}));
      return record.cancellation;
    }
    function release(record) {
      if (!record.reader || record.released || record.release) return record.release || Promise.resolve();
      record.release = hold(Promise.allSettled([...record.reads, ...(record.cancellation ? [record.cancellation] : [])]).then(() => {
        try {record.reader.releaseLock();} catch {}
        record.released = true;
      }));
      return record.release;
    }
    function wrap(response) {
      if (!response || typeof response !== 'object') return response;
      if (known.has(response)) return known.get(response).response;
      const record = {body: response.body, reads: new Set(), reader: null, released: false};
      records.add(record);
      const body = record.body && new Proxy(record.body, {get(target, key) {
        if (key === 'cancel') return () => cancel(record);
        if (key === 'getReader') return (...args) => {
          guard();
          const reader = target.getReader(...args);
          record.reader = reader; record.released = false; record.release = null;
          return new Proxy(reader, {get(current, member) {
            if (member === 'read') return (...readArgs) => {
              guard();
              if (record.cancellation) throw failure('CANCELLED');
              const reading = hold(Promise.resolve().then(() => current.read(...readArgs)));
              record.reads.add(reading);
              reading.then(() => record.reads.delete(reading), () => record.reads.delete(reading));
              return hold(reading.then(part => {guard(); return part;}));
            };
            if (member === 'cancel') return () => cancel(record);
            if (member === 'releaseLock') return () => {void cancel(record); void release(record);};
            const value = Reflect.get(current, member, current);
            return typeof value === 'function' ? value.bind(current) : value;
          }});
        };
        if (key === Symbol.asyncIterator || key === 'values') return (...args) => {
          guard();
          const iterator = target[key](...args);
          // Iterator cancellation is asynchronous too. Keep its pending next()
          // and return() in the same response lifetime as a direct reader.
          record.reader = {cancel: () => iterator.return(), releaseLock() {}};
          const proxy = new Proxy(iterator, {get(current, member) {
            if (member === Symbol.asyncIterator) return () => proxy;
            if (['next', 'return', 'throw'].includes(member)) return (...iteratorArgs) => {
              guard();
              if (record.cancellation) throw failure('CANCELLED');
              const reading = hold(Promise.resolve().then(() => current[member](...iteratorArgs)));
              record.reads.add(reading);
              reading.then(() => record.reads.delete(reading), () => record.reads.delete(reading));
              return hold(reading.then(part => {guard(); return part;}));
            };
            const value = Reflect.get(current, member, current);
            return typeof value === 'function' ? value.bind(current) : value;
          }});
          return proxy;
        };
        if (['tee', 'pipeThrough'].includes(key)) return () => {throw new TypeError('Use a tracked response reader.');};
        if (key === 'pipeTo') return (...args) => {
          guard();
          const piping = hold(Promise.resolve().then(() => target.pipeTo(...args)));
          record.reads.add(piping);
          piping.then(() => record.reads.delete(piping), () => record.reads.delete(piping));
          return piping;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      const proxy = new Proxy(response, {get(target, key) {
        if (key === 'body') return body;
        if (key === 'clone') return () => {throw new TypeError('Use a tracked response reader.');};
        const value = Reflect.get(target, key, target);
        if (['text', 'json', 'arrayBuffer', 'blob', 'bytes', 'formData'].includes(key) && typeof value === 'function') {
          return (...args) => {
            guard();
            if (record.cancellation) throw failure('CANCELLED');
            const reading = hold(Promise.resolve().then(() => value.apply(target, args)));
            record.reads.add(reading);
            reading.then(() => record.reads.delete(reading), () => record.reads.delete(reading));
            return hold(reading.then(result => {guard(); return result;}));
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      record.response = proxy; known.set(response, record); known.set(proxy, record);
      return proxy;
    }
    function cancelBody(response) {return cancel(known.get(response));}
    function trackedFetch(input, init = {}) {
      guard();
      const operation = fetchTail.then(async () => {
        // A work callback may issue several requests. Its one reserved physical
        // slot must cover the previous response as well as the next fetch.
        if (previousResponse) {
          await cancel(previousResponse);
          await Promise.allSettled([...previousResponse.reads]);
          await release(previousResponse);
        }
        guard();
        if (ended) throw failure('CANCELLED');
        const response = await fetchImpl(input, {...init, credentials: 'omit', signal: job.controller.signal});
        const wrapped = wrap(response);
        previousResponse = known.get(wrapped);
        if (ended || job.controller.signal.aborted) {await cancelBody(wrapped); guard();}
        return wrapped;
      });
      fetchTail = operation.catch(() => {});
      return hold(operation);
    }
    async function readBody(response, {maxBytes, maxReads = 8192} = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxReads) || maxReads < 1) throw new TypeError('Invalid response bound.');
      guard();
      if (typeof response?.body?.getReader !== 'function') throw failure('INVALID_RESPONSE');
      const reader = response.body.getReader(), chunks = [];
      let size = 0, reads = 0;
      try {
        while (true) {
          guard();
          if (++reads > maxReads) throw failure('RESPONSE_TOO_LARGE');
          const part = await reader.read();
          guard();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array) || part.value.byteLength > maxBytes - size) throw failure('RESPONSE_TOO_LARGE');
          size += part.value.byteLength;
          if (part.value.byteLength) chunks.push(Buffer.from(part.value));
        }
        return Buffer.concat(chunks, size);
      } finally {await cancelBody(response); await release(known.get(response));}
    }
    function sleep(milliseconds) {
      guard();
      return hold(new Promise((resolve, reject) => {
        const stopSleep = () => {clearTimeout(timer); reject(job.error);};
        const timer = setTimeout(() => {job.controller.signal.removeEventListener('abort', stopSleep); resolve();}, Math.max(0, milliseconds));
        job.controller.signal.addEventListener('abort', stopSleep, {once: true});
      }));
    }
    const onAbort = () => {for (const record of records) void cancel(record);};
    job.controller.signal.addEventListener('abort', onAbort, {once: true});
    return {api: {signal: job.controller.signal, fetch: trackedFetch, readBody, cancelBody, guard, sleep, hold},
      async cleanup() {
        ended = true;
        for (const record of records) void cancel(record);
        // A late fetch can register another response. Drain again after every
        // settlement; never replace this with a logical Promise.race.
        while (pending.size) await Promise.allSettled([...pending]);
        for (const record of records) {await cancel(record); await release(record);}
        while (pending.size) await Promise.allSettled([...pending]);
        job.controller.signal.removeEventListener('abort', onAbort);
      }};
  }
  async function execute(job) {
    const lifetime = context(job);
    let value, error;
    try {lifetime.api.guard(); value = await job.work(lifetime.api);} catch (caught) {error = caught;}
    await lifetime.cleanup();
    finishLogical(job, error, value);
    active.delete(job); detach(job);
    if (intervalFrom === 'finish') nextStartAt = Date.now() + minRequestIntervalMs;
    job.resolveSettled(); drain();
  }
  function drain() {
    clearTimeout(pacingTimer); pacingTimer = undefined;
    if (closed || !queue.length || active.size >= maxConcurrent) return;
    if (nextStartAt > Date.now()) {pacingTimer = setTimeout(drain, nextStartAt - Date.now()); return;}
    while (!closed && queue.length && active.size < maxConcurrent && nextStartAt <= Date.now()) {
      const job = queue.shift(); active.add(job);
      // start deadlines begin after pacing, when the physical work starts.
      if (job.timeoutFrom === 'start') job.timer = setTimeout(() => stop(job, 'TIMEOUT'), job.deadline);
      if (intervalFrom === 'start') nextStartAt = Date.now() + minRequestIntervalMs;
      void execute(job);
    }
    if (queue.length && active.size < maxConcurrent) pacingTimer = setTimeout(drain, Math.max(0, nextStartAt - Date.now()));
  }
  return {
    run(work, {signal, timeoutMs: deadline = timeoutMs, timeoutFrom: deadlineFrom = timeoutFrom} = {}) {
      if (typeof work !== 'function' || !Number.isSafeInteger(deadline) || deadline < 1 || !['start', 'admission'].includes(deadlineFrom)) throw new TypeError('Invalid public request.');
      let resolve, reject, resolveSettled;
      const result = new Promise((yes, no) => {resolve = yes; reject = no;});
      result.catch(() => {});
      const settled = new Promise(done => {resolveSettled = done;});
      const rejected = closed ? 'CLOSED' : signal?.aborted ? 'CANCELLED' :
        (active.size >= maxConcurrent || nextStartAt > Date.now() || queue.length) && queue.length >= maxQueued ? 'BUSY' : null;
      if (rejected) {reject(failure(rejected)); resolveSettled(); return {result, settled, admitted: false};}
      const job = {work, resolve, reject, resolveSettled, controller: new AbortController(), externalSignal: signal, deadline, timeoutFrom: deadlineFrom};
      job.onAbort = () => stop(job, 'CANCELLED');
      signal?.addEventListener('abort', job.onAbort, {once: true});
      queue.push(job);
      if (deadlineFrom === 'admission') job.timer = setTimeout(() => stop(job, 'TIMEOUT'), deadline);
      if (signal?.aborted) stop(job, 'CANCELLED'); else drain();
      return {result, settled, admitted: true};
    },
    getState() {return {active: active.size, queued: queue.length, closed};},
    close() {
      if (closed) return;
      closed = true; clearTimeout(pacingTimer);
      for (const job of [...active, ...queue]) stop(job, 'CLOSED');
    }
  };
}

module.exports = {createBoundedSerialFetch};
