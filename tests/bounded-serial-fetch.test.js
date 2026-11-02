'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createBoundedSerialFetch} = require('../src/main/bounded-serial-fetch');
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const manualClocks = new WeakMap();
function service(t, options) {const transport = createBoundedSerialFetch({clock: manualClocks.get(t), ...options}); t.after(() => transport.close()); return transport;}
const response = () => new Response('fixture');
function manualClock(t) {t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000}); manualClocks.set(t, {now: () => Date.now()}); return t.mock.timers;}
function dispatchClock() {
  let mono = 0, wall = 100000, sequence = 0;
  const timers = new Map();
  return {now: () => mono, wallNow: () => wall,
    setTimeout(callback, delay) {const timer = {id: ++sequence, callback, due: mono + Math.max(0, Number(delay) || 0)}; timers.set(timer.id, timer); return timer;},
    clearTimeout(timer) {if (timer) timers.delete(timer.id);},
    advance(delta, wallDelta = delta) {
      assert.ok(delta >= 0); mono += delta; wall += wallDelta;
      for (let step = 0; step < 1000; step++) {
        const timer = [...timers.values()].filter(value => value.due <= mono).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!timer) return; timers.delete(timer.id); timer.callback();
      }
      throw new Error('Dispatch timers did not converge.');
    },
    wakeEarly() {const timer = [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0]; assert.ok(timer); timers.delete(timer.id); timer.callback();}
  };
}
async function microtasks() {for (let index = 0; index < 40; index++) await Promise.resolve();}

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

test('actual dispatch waits from delayed fetch invocation and rechecks a prematurely awakened timer', async t => {
  const clock = dispatchClock(), prepare = deferred(), firstStarted = deferred(), secondStarted = deferred(), network = deferred(), starts = [];
  const transport = service(t, {clock, maxConcurrent: 2, minRequestIntervalMs: 1000, timeoutMs: 8000, timeoutFrom: 'start', fetchImpl: () => {
    starts.push(clock.now()); if (starts.length === 1) {firstStarted.resolve(); return network.promise;} secondStarted.resolve(); return response();
  }});
  const first = transport.run(async context => {await prepare.promise; return context.fetch('https://fixture.invalid/one');});
  const second = transport.run(context => context.fetch('https://fixture.invalid/two'));
  try {
    clock.advance(900); prepare.resolve(); await firstStarted.promise;
    clock.advance(100); await microtasks(); assert.deepEqual(starts, [900]); assert.equal(transport.getState().active, 2);
    clock.advance(899); clock.wakeEarly(); await microtasks(); assert.deepEqual(starts, [900]);
    clock.advance(1); await secondStarted.promise; assert.deepEqual(starts, [900, 1900]);
    t.diagnostic(JSON.stringify({actualDispatches: starts, monotonicGap: starts[1] - starts[0], earlyWakeAt: 1899}));
    await second.result;
  } finally {transport.close(); prepare.resolve(); network.resolve(response()); await Promise.all([first.settled, second.settled]);}
});

for (const outcome of ['pending', 'throw']) test(`start pacing stamps synchronous adapter ${outcome === 'throw' ? 'throw' : 'handoff'} completion without awaiting the response`, async t => {
  const clock = dispatchClock(), began = [deferred(), deferred()], network = deferred(), starts = [], handoffs = [];
  const transport = service(t, {clock, maxConcurrent: 2, minRequestIntervalMs: 1000, timeoutMs: 8000, fetchImpl: () => {
    starts.push(clock.now());
    if (starts.length === 1) {
      clock.advance(200); handoffs.push(clock.now()); began[0].resolve();
      if (outcome === 'throw') throw new Error('Injected synchronous adapter failure.');
      return network.promise;
    }
    handoffs.push(clock.now()); began[1].resolve(); return response();
  }});
  const first = transport.run(context => context.fetch('https://fixture.invalid/one'));
  const second = transport.run(context => context.fetch('https://fixture.invalid/two'));
  try {
    await began[0].promise;
    if (outcome === 'throw') await assert.rejects(first.result, /Injected synchronous adapter failure/);
    clock.advance(800); await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(199); clock.wakeEarly(); await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(1); await began[1].promise;
    assert.deepEqual(starts, [0, 1200]); assert.deepEqual(handoffs, [200, 1200]);
    t.diagnostic(JSON.stringify({outcome, actualDispatches: starts, synchronousHandoffs: handoffs, handoffGap: handoffs[1] - handoffs[0]}));
    await second.result;
  } finally {transport.close(); network.resolve(response()); await Promise.all([first.settled, second.settled]);}
});

for (const adjustment of [-5000, 5000]) test(`wall adjustment ${adjustment} cannot advance or stall a monotonic dispatch deadline`, async t => {
  const clock = dispatchClock(), starts = [], secondStarted = deferred();
  t.mock.method(Date, 'now', clock.wallNow);
  const transport = service(t, {clock, minRequestIntervalMs: 1000, timeoutMs: 8000, fetchImpl: async () => {
    starts.push(clock.now()); if (starts.length === 2) secondStarted.resolve(); return response();
  }});
  const first = transport.run(context => context.fetch('https://fixture.invalid/one')); let second;
  try {
    await first.result; clock.advance(0, adjustment);
    second = transport.run(context => context.fetch('https://fixture.invalid/two')); await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(999); clock.wakeEarly(); await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(1); await secondStarted.promise; await second.result; assert.deepEqual(starts, [0, 1000]);
    t.diagnostic(JSON.stringify({wallAdjustment: adjustment, actualDispatches: starts, monotonicGap: starts[1] - starts[0]}));
  } finally {transport.close(); await first.settled; await second?.settled;}
});

test('same-work fetch calls obey the global actual-dispatch interval as well as their own body fence', async t => {
  const clock = dispatchClock(), starts = [], began = [deferred(), deferred()];
  const transport = service(t, {clock, minRequestIntervalMs: 1000, timeoutMs: 8000, fetchImpl: async () => {starts.push(clock.now()); began[starts.length - 1].resolve(); return response();}});
  const job = transport.run(context => Promise.all([context.fetch('https://fixture.invalid/one'), context.fetch('https://fixture.invalid/two')]));
  try {
    await began[0].promise; await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(999); clock.wakeEarly(); await microtasks(); assert.deepEqual(starts, [0]);
    clock.advance(1); await began[1].promise; await job.result; assert.deepEqual(starts, [0, 1000]);
  } finally {transport.close(); await job.settled;}
});

for (const releaseReadFirst of [false, true]) test(`dispatch pacing retains ignored read/cancel slots (${releaseReadFirst ? 'read' : 'cancel'} first) while another fetch uses slot two`, async t => {
  const clock = dispatchClock(), read = deferred(), cancel = deferred(), reading = deferred(), cancelling = deferred(), network = deferred();
  const began = [deferred(), deferred(), deferred()], starts = []; let cancels = 0, releases = 0, physicalDone = false;
  const transport = service(t, {clock, maxConcurrent: 2, maxQueued: 1, minRequestIntervalMs: 1000, timeoutMs: 8000, timeoutFrom: 'start', fetchImpl: () => {
    starts.push(clock.now()); began[starts.length - 1].resolve();
    if (starts.length === 1) return {body: {getReader: () => ({read() {reading.resolve(); return read.promise;},
      cancel() {cancels++; cancelling.resolve(); return cancel.promise;}, releaseLock() {releases++;}})}};
    return starts.length === 2 ? network.promise : response();
  }});
  const first = transport.run(async context => context.readBody(await context.fetch('https://fixture.invalid/one'), {maxBytes: 32}), {timeoutMs: 500});
  const second = transport.run(context => context.fetch('https://fixture.invalid/two')); let third;
  first.settled.then(() => {physicalDone = true;});
  try {
    await reading.promise; clock.advance(500); await assert.rejects(first.result, {code: 'TIMEOUT'}); await cancelling.promise;
    clock.advance(500); await began[1].promise; assert.equal(transport.getState().active, 2); assert.equal(physicalDone, false);
    third = transport.run(context => context.fetch('https://fixture.invalid/three'));
    if (releaseReadFirst) read.resolve({done: true}); else cancel.resolve();
    await microtasks(); assert.equal(physicalDone, false); assert.equal(releases, 0); assert.deepEqual(starts, [0, 1000]);
    if (releaseReadFirst) cancel.resolve(); else read.resolve({done: true});
    await first.settled; assert.equal(cancels, 1); assert.equal(releases, 1);
    clock.advance(999); await microtasks(); assert.deepEqual(starts, [0, 1000]);
    clock.advance(1); await began[2].promise; await third.result; assert.deepEqual(starts, [0, 1000, 2000]);
  } finally {transport.close(); read.resolve({done: true}); cancel.resolve(); network.resolve(response()); await Promise.all([first.settled, second.settled, ...(third ? [third.settled] : [])]);}
});

test('two ignored-abort fetches retain both physical slots and queued admission expiry never dispatches late', async t => {
  const clock = dispatchClock(), gates = [], starts = [], began = [deferred(), deferred()];
  const transport = service(t, {clock, maxConcurrent: 2, maxQueued: 1, minRequestIntervalMs: 1000, timeoutMs: 2500, fetchImpl: () => {
    starts.push(clock.now()); const gate = deferred(); gates.push(gate); began[starts.length - 1].resolve(); return gate.promise;
  }});
  const first = transport.run(context => context.fetch('https://fixture.invalid/one'));
  const second = transport.run(context => context.fetch('https://fixture.invalid/two')); let third;
  try {
    await began[0].promise; clock.advance(1000); await began[1].promise;
    third = transport.run(context => context.fetch('https://fixture.invalid/three'));
    const overflow = transport.run(() => assert.fail('overflow work ran')); assert.equal(overflow.admitted, false); await assert.rejects(overflow.result, {code: 'BUSY'});
    clock.advance(1500); await Promise.all([assert.rejects(first.result, {code: 'TIMEOUT'}), assert.rejects(second.result, {code: 'TIMEOUT'})]);
    assert.equal(transport.getState().active, 2); assert.equal(transport.getState().queued, 1);
    clock.advance(1000); await assert.rejects(third.result, {code: 'TIMEOUT'}); await third.settled;
    assert.equal(transport.getState().active, 2); assert.equal(transport.getState().queued, 0); assert.deepEqual(starts, [0, 1000]);
  } finally {transport.close(); for (const gate of gates) gate.resolve(response()); await Promise.all([first.settled, second.settled, ...(third ? [third.settled] : [])]);}
});

for (const reason of ['abort', 'close', 'timeout']) test(`${reason} removes an active paced dispatch ticket promptly without a later fetch call`, async t => {
  const clock = dispatchClock(), prepare = deferred(), network = deferred(), firstStarted = deferred(), controller = new AbortController(), starts = [];
  const transport = service(t, {clock, maxConcurrent: 2, minRequestIntervalMs: 1000, timeoutMs: 8000, timeoutFrom: 'start', fetchImpl: () => {
    starts.push(clock.now()); firstStarted.resolve(); return network.promise;
  }});
  const first = transport.run(async context => {await prepare.promise; return context.fetch('https://fixture.invalid/one');});
  const second = transport.run(context => context.fetch('https://fixture.invalid/two'), {signal: controller.signal, timeoutMs: reason === 'timeout' ? 100 : 8000});
  try {
    clock.advance(900); prepare.resolve(); await firstStarted.promise;
    clock.advance(100); await microtasks(); assert.equal(transport.getState().active, 2); assert.deepEqual(starts, [900]);
    if (reason === 'abort') controller.abort(); else if (reason === 'close') transport.close(); else clock.advance(100);
    await assert.rejects(second.result, {code: {abort: 'CANCELLED', close: 'CLOSED', timeout: 'TIMEOUT'}[reason]});
    await second.settled; assert.equal(transport.getState().active, 1);
    clock.advance(2000); await microtasks(); assert.deepEqual(starts, [900]);
  } finally {transport.close(); prepare.resolve(); network.resolve(response()); await Promise.all([first.settled, second.settled]);}
});

for (const cancelledIndex of [1, 2]) test(`removing paced ticket ${cancelledIndex} cannot let a later ticket bypass a still-valid deadline or FIFO order`, async t => {
  const clock = dispatchClock(), prepared = Array.from({length: 4}, () => deferred()), networks = [], starts = [];
  const controllers = Array.from({length: 4}, () => new AbortController());
  const transport = service(t, {clock, maxConcurrent: 4, minRequestIntervalMs: 1000, timeoutMs: 10000, timeoutFrom: 'start', fetchImpl: url => {
    starts.push({name: new URL(url).pathname, at: clock.now()}); const gate = deferred(); networks.push(gate); return gate.promise;
  }});
  const jobs = prepared.map((gate, index) => transport.run(async context => {await gate.promise; return context.fetch(`https://fixture.invalid/${index}`);}, {signal: controllers[index].signal}));
  try {
    for (let index = 0; index < 3; index++) {clock.advance(1000); await microtasks();}
    prepared.forEach(gate => gate.resolve()); await microtasks(); assert.deepEqual(starts, [{name: '/0', at: 3000}]);
    clock.advance(500); controllers[cancelledIndex].abort(); await assert.rejects(jobs[cancelledIndex].result, {code: 'CANCELLED'}); await jobs[cancelledIndex].settled;
    assert.deepEqual(starts, [{name: '/0', at: 3000}]);
    clock.advance(500); await microtasks(); clock.advance(999); clock.wakeEarly(); await microtasks(); assert.equal(starts.length, 2);
    clock.advance(1); await microtasks();
    const live = [0, 1, 2, 3].filter(index => index !== cancelledIndex);
    assert.deepEqual(starts, live.map((index, order) => ({name: `/${index}`, at: 3000 + order * 1000})));
  } finally {transport.close(); prepared.forEach(gate => gate.resolve()); networks.forEach(gate => gate.resolve(response())); await Promise.all(jobs.map(job => job.settled));}
});
