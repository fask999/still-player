'use strict';

// In-memory HTTP transport: receiving a request, applying it at the server,
// receiving headers and consuming its body are separate causal events. Aborting
// the client or dropping its connection never revokes an already received write.
function createFakeBeefwebHttp(handle, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:18880/api/';
  const calls = [], tasks = new Set();
  let bodyHook = null;
  const fetch = (input, init = {}) => {
    const url = new URL(input, baseUrl), signal = init.signal;
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const call = { url, route: url.pathname.replace(/^\/api\//, ''), method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null, signal, headersSent: false, bodyRead: false,
      bodySettled: false, serverSettled: false };
    calls.push(call);
    let resolveHeaders, rejectHeaders, rejectFailure, failure = null;
    const headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const failed = new Promise((_resolve, reject) => { rejectFailure = reject; });
    // A connection can fail before the consumer starts reading the body.
    failed.catch(() => {});
    const removeAbort = () => signal?.removeEventListener('abort', onAbort);
    const drop = (error = new TypeError('Synthetic connection dropped')) => {
      if (failure || call.bodySettled) return;
      failure = error; rejectHeaders(error); rejectFailure(error); removeAbort();
    };
    const onAbort = () => drop(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = (value, status = 200) => {
      if (call.headersSent || failure) return;
      // Freeze the wire bytes now; a later server mutation must not rewrite a
      // stale response which is already waiting in the client's body stream.
      const hasBody = call.method !== 'HEAD' && ![204, 205, 304].includes(status);
      const bytes = !hasBody || value == null ? '' : JSON.stringify(value);
      call.status = status; call.headersSent = true;
      resolveHeaders({ ok: status >= 200 && status < 300, status, url: url.href, redirected: false,
        async text() {
          if (call.bodyRead) throw new TypeError('Body has already been consumed');
          call.bodyRead = true;
          try {
            const read = Promise.resolve().then(async () => { if (hasBody && bodyHook) await bodyHook(call); return bytes; });
            const result = await Promise.race([read, failed]);
            call.bodySettled = true;
            return result;
          } finally { removeAbort(); }
        }
      });
    };
    // Always yield after dispatch registration and before the physical handler.
    const task = Promise.resolve().then(() => handle({ ...call, call, send, drop }))
      .catch(drop).finally(() => { call.serverSettled = true; tasks.delete(task); });
    tasks.add(task);
    return headers;
  };
  return { baseUrl, calls, fetch, setBodyHook: hook => { bodyHook = hook; },
    async drain() { while (tasks.size) await Promise.all([...tasks]); } };
}

module.exports = { createFakeBeefwebHttp };
