'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createBoundedSerialFetch} = require('../src/main/bounded-serial-fetch');
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function service(t, options) {const transport = createBoundedSerialFetch(options); t.after(() => transport.close()); return transport;}
const response = () => new Response('fixture');
function manualClock(t) {t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000}); return t.mock.timers;}

test('physical fetches retain both slots while expired queue entries are removed under continued pressure', async t => {
  const clock = manualClock(t), gate = deferred(), started = deferred(); let calls = 0;
  const transport = service(t, {maxConcurrent: 2, maxQueued: 2, timeoutMs: 20, fetchImpl: async () => {if (++calls === 2) started.resolve(); return gate.promise;}});
  const handles = Array.from({length: 4}, () => transport.run(context => context.fetch('https://fixture.invalid')));
  try {
    const overflow = transport.run(() => assert.fail('overflow ran'));
    assert.equal(overflow.admitted, false); await assert.rejects(overflow.result, {code: 'BUSY'});
    assert.deepEqual(transport.getState(), {active: 2, queued: 2, closed: false});
    await started.promise; clock.tick(20);
    const results = await Promise.allSettled(handles.map(handle => handle.result));
    assert.ok(results.every(result => result.reason.code === 'TIMEOUT'));
    assert.equal(calls, 2); assert.deepEqual(transport.getState(), {active: 2, queued: 0, closed: false});
    for (let wave = 0; wave < 3; wave++) {
      const pressure = Array.from({length: 2}, () => assert.rejects(transport.run(() => assert.fail('timed-out waiting work ran')).result, {code: 'TIMEOUT'}));
      clock.tick(20); await Promise.all(pressure);
      assert.equal(calls, 2);
    }
    gate.resolve(response()); await Promise.all(handles.map(handle => handle.settled));
    assert.equal(transport.getState().active, 0);
  } finally {transport.close(); gate.resolve(response()); await Promise.all(handles.map(handle => handle.settled));}
});

test('queued abort, admission deadline and close settle promptly without running work', async t => {
  const clock = manualClock(t), gate = deferred(), started = deferred(), controller = new AbortController();
  const transport = service(t, {timeoutMs: 1000, maxQueued: 2, fetchImpl: async () => {started.resolve(); return gate.promise;}});
  const active = transport.run(context => context.fetch('https://fixture.invalid'));
  try {
    const stopped = transport.run(() => assert.fail('aborted waiting job ran'), {signal: controller.signal});
    controller.abort(); await assert.rejects(stopped.result, {code: 'CANCELLED'}); await stopped.settled;
    const timed = transport.run(() => assert.fail('expired waiting job ran'), {timeoutMs: 15});
    await started.promise; clock.tick(15);
    await assert.rejects(timed.result, {code: 'TIMEOUT'}); await timed.settled;
    const queued = transport.run(() => assert.fail('closed waiting job ran'));
    transport.close();
    await Promise.all([assert.rejects(active.result, {code: 'CLOSED'}), assert.rejects(queued.result, {code: 'CLOSED'})]);
    assert.equal(transport.getState().queued, 0); assert.equal(transport.getState().active, 1);
    const denied = transport.run(() => assert.fail('closed work ran')); assert.equal(denied.admitted, false);
    await assert.rejects(denied.result, {code: 'CLOSED'});
    gate.resolve(response()); await active.settled;
  } finally {transport.close(); gate.resolve(response()); await active.settled;}
});

test('late fetch response cancellation must physically settle before another fetch starts', async t => {
  const fetchGate = deferred(), cancelGate = deferred(), cancelling = deferred(), controller = new AbortController();
  let calls = 0, cancels = 0, physicalDone = false;
  const transport = service(t, {timeoutMs: 1000, fetchImpl: async () => ++calls === 1 ? fetchGate.promise : response()});
  const first = transport.run(context => context.fetch('https://fixture.invalid'), {signal: controller.signal});
  await tick(); controller.abort(); await assert.rejects(first.result, {code: 'CANCELLED'});
  first.settled.then(() => {physicalDone = true;});
  const next = transport.run(async context => {const received = await context.fetch('https://fixture.invalid'); return context.readBody(received, {maxBytes: 50});});
  fetchGate.resolve({body: {cancel() {cancels++; cancelling.resolve(); return cancelGate.promise;}}});
  await cancelling.promise; await tick(); assert.equal(calls, 1); assert.equal(physicalDone, false);
  cancelGate.resolve(); assert.equal((await next.result).toString(), 'fixture'); await first.settled;
  assert.equal(calls, 2); assert.equal(cancels, 1);
});

for (const direct of [false, true]) for (const readFirst of [false, true]) {
  test(`${direct ? 'direct reader' : 'bounded reader'} tracks ignored read and cancel independently (${readFirst ? 'read' : 'cancel'} first)`, async t => {
    const clock = manualClock(t), readGate = deferred(), cancelGate = deferred(), started = deferred();
    let calls = 0, cancels = 0, releases = 0, settled = false;
    const transport = service(t, {timeoutMs: 20, fetchImpl: async () => {
      calls++;
      return {body: {getReader() {return {
        read() {started.resolve(); return readGate.promise;}, cancel() {cancels++; return cancelGate.promise;}, releaseLock() {releases++;}
      };}}};
    }});
    const job = transport.run(async context => {
      const received = await context.fetch('https://fixture.invalid');
      if (!direct) return context.readBody(received, {maxBytes: 20});
      const reader = received.body.getReader();
      try {return await reader.read();} finally {reader.releaseLock();}
    });
    try {
      job.settled.then(() => {settled = true;});
      await started.promise; clock.tick(20); await assert.rejects(job.result, {code: 'TIMEOUT'});
      assert.equal(cancels, 1);
      if (readFirst) readGate.resolve({done: true}); else cancelGate.resolve();
      await tick(); assert.equal(settled, false); assert.equal(transport.getState().active, 1); assert.equal(releases, 0);
      const queued = transport.run(() => assert.fail('pending physical read/cancel released slot'));
      transport.close(); await assert.rejects(queued.result, {code: 'CLOSED'});
      if (readFirst) cancelGate.resolve(); else readGate.resolve({done: true});
      await job.settled; assert.equal(releases, 1); assert.equal(calls, 1); assert.equal(cancels, 1);
    } finally {transport.close(); readGate.resolve({done: true}); cancelGate.resolve(); await job.settled;}
  });
}

test('unawaited fetch, direct read and hold remain part of the physical lifetime', async t => {
  const clock = manualClock(t), readGate = deferred(), cancelGate = deferred(), cleanupGate = deferred(), started = deferred();
  const late = deferred(), lateStarted = deferred(); let transport2, unawaited;
  const transport = service(t, {timeoutMs: 20, fetchImpl: async () => ({body: {getReader: () => ({
    read() {started.resolve(); return readGate.promise;}, cancel: () => cancelGate.promise, releaseLock() {}
  })}})});
  const job = transport.run(async context => {
    const received = await context.fetch('https://fixture.invalid');
    void received.body.getReader().read().catch(() => {});
    context.hold(cleanupGate.promise);
    return 'finished logically';
  });
  try {
    await started.promise; clock.tick(20);
    await assert.rejects(job.result, {code: 'TIMEOUT'});
    readGate.resolve({done: true}); cancelGate.resolve(); await tick();
    assert.equal(transport.getState().active, 1);
    cleanupGate.resolve(); await job.settled; assert.equal(transport.getState().active, 0);
    transport2 = service(t, {timeoutMs: 20, fetchImpl: async () => {lateStarted.resolve(); return late.promise;}});
    unawaited = transport2.run(context => {void context.fetch('https://fixture.invalid').catch(() => {}); return 'early';});
    await lateStarted.promise; clock.tick(20);
    await assert.rejects(unawaited.result, {code: 'TIMEOUT'}); assert.equal(transport2.getState().active, 1);
    late.resolve(response()); await unawaited.settled;
  } finally {
    transport.close(); transport2?.close(); readGate.resolve({done: true}); cancelGate.resolve(); cleanupGate.resolve(); late.resolve(response());
    await job.settled; await unawaited?.settled;
  }
});

test('body bounds and response method consumers are tracked and bytes are copied', async t => {
  const bytes = Uint8Array.from([65, 66]);
  const transport = service(t, {fetchImpl: async () => new Response(bytes)});
  const result = await transport.run(async context => context.readBody(await context.fetch('https://fixture.invalid'), {maxBytes: 2})).result;
  bytes.fill(88); assert.equal(result.toString(), 'AB');
  await assert.rejects(transport.run(async context => context.readBody(await context.fetch('https://fixture.invalid'), {maxBytes: 1})).result, {code: 'RESPONSE_TOO_LARGE'});
  assert.equal(await transport.run(async context => (await context.fetch('https://fixture.invalid')).text()).result, 'XX');
});

test('start and finish pacing preserve physical start intervals', async t => {
  const clock = manualClock(t);
  for (const intervalFrom of ['start', 'finish']) {
    const starts = [], began = [deferred(), deferred()];
    const transport = service(t, {maxConcurrent: intervalFrom === 'start' ? 2 : 1, minRequestIntervalMs: 35,
      intervalFrom, timeoutMs: 1000, fetchImpl: async () => {starts.push(Date.now()); began[starts.length - 1].resolve(); await wait(20); return response();}});
    const handles = Array.from({length: 2}, () => transport.run(context => context.fetch('https://fixture.invalid')));
    try {
      await began[0].promise; clock.tick(20); await handles[0].result;
      clock.tick(intervalFrom === 'start' ? 14 : 34); assert.equal(starts.length, 1);
      clock.tick(1); await began[1].promise;
      assert.equal(starts[1] - starts[0], intervalFrom === 'start' ? 35 : 55);
      clock.tick(20); await handles[1].result;
    } finally {transport.close(); clock.runAll(); await Promise.all(handles.map(handle => handle.settled));}
  }
});

test('start deadline begins after pacing while queue remains hard bounded', async t => {
  const clock = manualClock(t);
  let calls = 0;
  const transport = service(t, {timeoutMs: 15, timeoutFrom: 'start', minRequestIntervalMs: 40, maxQueued: 1,
    fetchImpl: async () => {calls++; return response();}});
  await transport.run(context => context.fetch('https://fixture.invalid')).result;
  const queued = transport.run(context => context.fetch('https://fixture.invalid'));
  const overflow = transport.run(() => assert.fail('overflow started'));
  assert.equal(overflow.admitted, false); await assert.rejects(overflow.result, {code: 'BUSY'});
  clock.tick(39); assert.equal(calls, 1);
  clock.tick(1);
  await queued.result; assert.equal(calls, 2);
});

test('transport always supplies its lifetime signal and credentials omit', async t => {
  let options;
  const transport = service(t, {fetchImpl: async (_url, init) => {options = init; return response();}});
  await transport.run(context => context.fetch('https://fixture.invalid', {credentials: 'include', signal: new AbortController().signal})).result;
  assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal);
});

for (const readFirst of [false, true]) test(`one work callback waits for its previous response read and cancellation (${readFirst ? 'read' : 'cancel'} first)`, async t => {
  const read = deferred(), cancel = deferred(), cancelling = deferred(), started = deferred();
  let calls = 0;
  const transport = service(t, {timeoutMs: 1000, fetchImpl: async () => {
    calls++;
    if (calls > 1) return response();
    return {body: {getReader: () => ({read() {started.resolve(); return read.promise;}, cancel() {cancelling.resolve(); return cancel.promise;}, releaseLock() {}})}};
  }});
  const job = transport.run(async context => {
    const first = await context.fetch('https://fixture.invalid/first');
    void first.body.getReader().read().catch(() => {});
    return context.fetch('https://fixture.invalid/second');
  });
  await started.promise; await cancelling.promise; assert.equal(calls, 1);
  if (readFirst) read.resolve({done: true}); else cancel.resolve();
  await tick(); assert.equal(calls, 1);
  if (readFirst) cancel.resolve(); else read.resolve({done: true});
  await job.result; assert.equal(calls, 2);
});

test('concurrent fetch calls inside one work callback are physically serialized', async t => {
  const fetchGate = deferred(), cancelGate = deferred(), cancelling = deferred(); let calls = 0;
  const transport = service(t, {timeoutMs: 1000, fetchImpl: async () => ++calls === 1 ? fetchGate.promise : response()});
  const job = transport.run(context => Promise.all([context.fetch('https://fixture.invalid/first'), context.fetch('https://fixture.invalid/second')]));
  await tick(); assert.equal(calls, 1);
  fetchGate.resolve({body: {cancel() {cancelling.resolve(); return cancelGate.promise;}}});
  await cancelling.promise; await tick(); assert.equal(calls, 1);
  cancelGate.resolve(); await job.result; assert.equal(calls, 2);
});

for (const close of [false, true]) test(`${close ? 'close' : 'abort'} prevents a second fetch queued inside the same work callback`, async t => {
  const fetchGate = deferred(), cancelGate = deferred(), cancelling = deferred(), controller = new AbortController(); let calls = 0;
  const transport = service(t, {timeoutMs: 1000, fetchImpl: async () => {calls++; return fetchGate.promise;}});
  const job = transport.run(context => Promise.all([context.fetch('https://fixture.invalid/first'), context.fetch('https://fixture.invalid/second')]), {signal: controller.signal});
  await tick(); assert.equal(calls, 1);
  if (close) transport.close(); else controller.abort();
  await assert.rejects(job.result, {code: close ? 'CLOSED' : 'CANCELLED'});
  fetchGate.resolve({body: {cancel() {cancelling.resolve(); return cancelGate.promise;}}});
  await cancelling.promise; await tick(); assert.equal(calls, 1);
  cancelGate.resolve(); await job.settled; assert.equal(calls, 1);
});

for (const method of ['text', 'iterator']) test(`${method} body consumers retain their lifetime before a later fetch`, async t => {
  const readGate = deferred(), cancelGate = deferred(), cancelling = deferred(), started = deferred(); let calls = 0;
  const transport = service(t, {timeoutMs: 1000, fetchImpl: async () => {
    calls++; if (calls > 1) return response();
    const body = {cancel() {cancelling.resolve(); return cancelGate.promise;},
      [Symbol.asyncIterator]() {return {next() {started.resolve(); return readGate.promise;}, return() {cancelling.resolve(); return cancelGate.promise;}};}};
    return {body, text() {started.resolve(); return readGate.promise;}};
  }});
  const job = transport.run(async context => {
    const received = await context.fetch('https://fixture.invalid/first');
    if (method === 'text') void received.text().catch(() => {});
    else void received.body[Symbol.asyncIterator]().next().catch(() => {});
    return context.fetch('https://fixture.invalid/second');
  });
  await started.promise; await cancelling.promise;
  cancelGate.resolve({done: true}); await tick(); assert.equal(calls, 1);
  readGate.resolve({done: true}); await job.result; assert.equal(calls, 2);
});
