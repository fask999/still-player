'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {validateWindowPlacement, resolveWindowPlacement, createWindowPlacementController} = require('../src/main/window-placement');

const primary = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}, scaleFactor: 1};
const secondary = {id: 2, workArea: {x: -1600, y: -200, width: 1600, height: 1160}, scaleFactor: 1.5};
const saved = (bounds = {x: 70, y: 80, width: 900, height: 750}, extra = {}) => ({version: 1, bounds, maximized: false, ...extra});
const resolve = (value, displays = [primary, secondary], main = primary) => resolveWindowPlacement({saved: value, displays, primaryDisplay: main});
function inside(bounds, area) {
  assert.ok(bounds.width >= 1 && bounds.height >= 1);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}
function fixture({initial = saved(), persist = async () => {}} = {}) {
  const window = new EventEmitter(), screen = new EventEmitter(), jobs = new Map(), writes = [], errors = [], calls = [];
  let jobId = 0;
  Object.assign(window, {normal: {...initial?.bounds || saved().bounds}, maximized: false, minimized: false, visible: true, destroyed: false,
    isDestroyed() {return this.destroyed;}, isVisible() {return this.visible;}, isMinimized() {return this.minimized;},
    isMaximized() {return this.maximized;}, isFullScreen() {return false;},
    getNormalBounds() {return {...this.normal};},
    getBounds() {throw new Error('Must never save maximized/minimized getBounds');},
    setBounds(bounds) {calls.push(['bounds', {...bounds}]); this.normal = {...bounds}; this.emit('move'); this.emit('resize');},
    setMinimumSize(width, height) {calls.push(['minimum', width, height]);},
    maximize() {calls.push(['maximize']); this.maximized = true; this.emit('maximize');},
    unmaximize() {calls.push(['unmaximize']); this.maximized = false; this.emit('unmaximize');}
  });
  Object.assign(screen, {displays: [structuredClone(primary), structuredClone(secondary)],
    getAllDisplays() {return structuredClone(this.displays);}, getPrimaryDisplay() {return structuredClone(this.displays[0]);}});
  const clock = {setTimeout(callback) {const id = ++jobId; jobs.set(id, callback); return id;}, clearTimeout(id) {jobs.delete(id);}};
  const controller = createWindowPlacementController({window, screen, getSaved: () => initial, clock,
    persist: async value => {writes.push(structuredClone(value)); await persist(value);}, onError: error => errors.push(error)});
  return {window, screen, controller, jobs, writes, errors, calls,
    async tick() {for (const [id, callback] of [...jobs]) {jobs.delete(id); callback();} await controller.flush(false);},
    move(bounds) {window.normal = {...bounds}; window.emit('move'); window.emit('resize');}};
}

test('strict serializable schema accepts independent copies and null', () => {
  const input = saved(undefined, {displayId: -10, workArea: secondary.workArea, scaleFactor: 1.5});
  const value = validateWindowPlacement(input);
  assert.deepEqual(value, input);
  value.bounds.x = 300;
  value.workArea.x = 800;
  assert.equal(input.bounds.x, 70);
  assert.equal(input.workArea.x, -1600);
  assert.equal(validateWindowPlacement(null), null);
});

test('rejects corrupt, nonserializable, accessor, unknown and unsupported schema fields', () => {
  let reads = 0;
  const accessor = saved(); Object.defineProperty(accessor, 'displayId', {get() {reads++; return 1;}});
  for (const value of [undefined, [], {}, {...saved(), version: 2}, {...saved(), maximized: 1},
    {...saved(), bounds: {...saved().bounds, x: NaN}}, {...saved(), bounds: {...saved().bounds, width: 0}},
    {...saved(), bounds: {...saved().bounds, width: 10.5}}, {...saved(), bounds: {...saved().bounds, y: Infinity}},
    {...saved(), displayId: undefined}, {...saved(), displayId: 1n}, {...saved(), scaleFactor: 0},
    {...saved(), scaleFactor: Infinity}, {...saved(), workArea: null}, {...saved(), extra: true},
    {...saved(), bounds: {...saved().bounds, extra: 2}}, {...saved(), [Symbol('field')]: 1}, accessor]) {
    assert.throws(() => validateWindowPlacement(value));
    inside(resolve(value).placement.bounds, primary.workArea);
    assert.equal(resolve(value).restoreMaximized, false);
  }
  assert.equal(reads, 0);
});

test('default matches 1440x940 DIP, centers and clamps minima/default to small work areas', () => {
  assert.deepEqual(resolve(null).options, {x: 240, y: 50, width: 1440, height: 940, minWidth: 480, minHeight: 680});
  const tiny = {id: 3, workArea: {x: -900, y: 50, width: 320, height: 200}, scaleFactor: 2};
  assert.deepEqual(resolve(null, [tiny], tiny).options, {x: -900, y: 50, width: 320, height: 200, minWidth: 320, minHeight: 200});
  assert.deepEqual(resolve(saved({x: 0, y: 0, width: 1, height: 1})).placement.bounds, {x: 0, y: 0, width: 480, height: 680});
  inside(resolveWindowPlacement({displays: [{workArea: {width: NaN}}]}).placement.bounds, {x: 0, y: 0, width: 1440, height: 940});
});

test('negative coordinates choose intersecting display, full bounds clamp to one work area', () => {
  const result = resolve(saved({x: -1200, y: -160, width: 1000, height: 800}));
  assert.equal(result.placement.displayId, 2);
  assert.equal(result.options.x, -1200);
  assert.equal(result.options.y, -160);
  const crossing = resolve(saved({x: -700, y: -400, width: 900, height: 1500}));
  assert.equal(crossing.placement.displayId, 2);
  inside(crossing.options, secondary.workArea);
});

test('removed/offscreen display recenters on primary; same display relocates relative to old work area', () => {
  const missing = saved({x: -1500, y: -100, width: 900, height: 750}, {displayId: 2, workArea: secondary.workArea});
  const recovered = resolve(missing, [primary]);
  assert.equal(recovered.options.x, 510);
  assert.equal(recovered.options.y, 145);
  const moved = {...secondary, workArea: {x: 2500, y: 100, width: 1280, height: 900}};
  const restored = resolve(missing, [primary, moved]);
  assert.equal(restored.placement.displayId, 2);
  assert.equal(restored.options.width, 900);
  inside(restored.options, moved.workArea);
});

test('DPI-only changes keep logical size without physical-pixel rescaling', () => {
  const value = saved({x: -1500, y: -100, width: 900, height: 750}, {displayId: 2, workArea: secondary.workArea, scaleFactor: 1.5, maximized: true});
  const result = resolve(value, [primary, {...secondary, scaleFactor: 2}]);
  assert.deepEqual(result.placement.bounds, value.bounds);
  assert.equal(result.placement.scaleFactor, 2);
  assert.equal(result.restoreMaximized, true);
});

test('fixture sweep always produces fully visible integer rectangles and constrained minima', () => {
  for (const area of [primary.workArea, secondary.workArea, {x: -500, y: -700, width: 1, height: 1},
    {x: 2000, y: 100, width: 600, height: 500}]) {
    const display = {id: 4, workArea: area};
    for (const x of [-9999999, -500, 0, 9999999]) for (const size of [1, 480, 940, 1000000]) {
      const result = resolve(saved({x, y: x, width: size, height: size}), [display], display);
      inside(result.options, area);
      assert.ok(result.options.width >= result.options.minWidth);
      assert.ok(result.options.height >= result.options.minHeight);
      assert.ok(Object.values(result.options).every(Number.isInteger));
    }
  }
});

test('restore applies normal bounds before maximize and does not write during programmatic events', async () => {
  const f = fixture({initial: saved(undefined, {maximized: true})});
  f.window.normal = {x: 0, y: 0, width: 500, height: 700};
  const result = f.controller.restore();
  assert.equal(result.restoreMaximized, true);
  assert.deepEqual(f.calls.map(call => call[0]), ['minimum', 'bounds', 'maximize']);
  assert.equal(f.window.maximized, true);
  assert.equal(f.jobs.size, 0);
  await f.controller.flush();
  assert.deepEqual(f.writes[0].bounds, saved().bounds);
  assert.equal(f.writes[0].maximized, true);
  await f.controller.flush();
  assert.equal(f.writes.length, 1);
  f.controller.dispose();
});

test('drag updates display identity immediately, debounces writes and uses normal bounds on maximize', async () => {
  const f = fixture();
  f.controller.restore();
  f.move({x: -1200, y: -100, width: 850, height: 760});
  f.move({x: -1100, y: -100, width: 850, height: 760});
  assert.equal(f.jobs.size, 1);
  assert.equal(f.writes.length, 0);
  f.window.maximize();
  await f.tick();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].displayId, 2);
  assert.equal(f.writes[0].maximized, true);
  assert.equal(f.writes[0].bounds.x, -1100);
  f.controller.dispose();
});

test('minimized/hidden/transient invalid bounds never replace last normal placement', async () => {
  const f = fixture(); f.controller.restore();
  f.move({x: 100, y: 100, width: 900, height: 750});
  f.window.minimized = true;
  f.move({x: -32000, y: -32000, width: 1, height: 1});
  await f.controller.flush();
  assert.equal(f.writes[0].bounds.x, 100);
  f.window.minimized = false; f.window.visible = false;
  f.move({x: 0, y: 0, width: 1, height: 1});
  await f.controller.flush(); assert.equal(f.writes.length, 1);
  f.window.visible = true;
  f.window.normal.width = NaN;
  f.window.emit('resize'); await f.controller.flush();
  assert.equal(f.writes.length, 1);
  assert.ok(f.errors.length >= 1);
  f.controller.dispose();
});

test('unplug reflows cached stable placement, ignores preceding OS movement and retains maximization', async () => {
  const initial = saved({x: -1500, y: -100, width: 1000, height: 800}, {displayId: 2, workArea: secondary.workArea, maximized: true});
  const f = fixture({initial}); f.controller.restore();
  f.screen.displays = [structuredClone(primary)];
  f.move({x: 0, y: 0, width: 1500, height: 900}); // OS relocation arrives first.
  f.screen.emit('display-removed', {}, secondary);
  inside(f.window.normal, primary.workArea);
  assert.equal(f.window.normal.width, 1000);
  assert.equal(f.window.maximized, true);
  await f.tick(); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].displayId, 1);
  assert.equal(f.jobs.size, 0);
  f.controller.dispose();
});

test('DPI metrics restore logical dimensions, unrelated added display never steals or unmaximizes window', async () => {
  const f = fixture({initial: saved(undefined, {maximized: true})}); f.controller.restore();
  f.calls.length = 0;
  f.screen.displays.push({id: 3, workArea: {x: 3000, y: 0, width: 1920, height: 1080}, scaleFactor: 2});
  f.screen.emit('display-added', {}, f.screen.displays[2]);
  assert.deepEqual(f.calls.map(call => call[0]), []);
  assert.equal(f.window.maximized, true);
  f.screen.displays[0].scaleFactor = 2;
  f.move({x: 70, y: 80, width: 1800, height: 1500});
  f.screen.emit('display-metrics-changed', {}, f.screen.displays[0], ['scaleFactor']);
  assert.deepEqual(f.window.normal, saved().bounds);
  assert.equal(f.window.maximized, true);
  await f.tick(); assert.equal(f.writes.at(-1).scaleFactor, 2);
  f.controller.dispose();
});

test('small workarea lowers old minimum before setBounds and defers hidden/minimized topology changes', async () => {
  const f = fixture(); f.controller.restore();
  f.window.minimized = true; f.calls.length = 0;
  f.screen.displays = [{id: 1, workArea: {x: 0, y: 0, width: 300, height: 200}, scaleFactor: 2}];
  f.screen.emit('display-metrics-changed', {}, f.screen.displays[0], ['workArea']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.window.minimized, true);
  f.window.minimized = false; f.window.emit('restore');
  assert.deepEqual(f.calls[0], ['minimum', 300, 200]);
  inside(f.window.normal, f.screen.displays[0].workArea);
  await f.tick(); assert.equal(f.writes[0].bounds.width, 300);
  f.controller.dispose();
});

test('moving to a small connected display updates native minimum without retaining old display constraints', async () => {
  const f = fixture(); f.controller.restore();
  const tiny = {id: 3, workArea: {x: 2000, y: 0, width: 300, height: 200}, scaleFactor: 2};
  f.screen.displays.push(tiny); f.screen.emit('display-added', {}, tiny);
  f.calls.length = 0;
  f.move({x: 2000, y: 0, width: 300, height: 200});
  assert.deepEqual(f.calls[0], ['minimum', 300, 200]);
  await f.tick(); assert.equal(f.writes.at(-1).displayId, 3);
  f.move(saved().bounds);
  assert.deepEqual(f.calls.at(-1), ['minimum', 480, 680]);
  f.controller.dispose();
});

test('corrupt saved geometry and invalid native initial bounds recover to a usable startup rectangle', () => {
  const initial = saved({x: NaN, y: Infinity, width: 0, height: 0}, {version: 99});
  const f = fixture({initial});
  const result = f.controller.restore();
  assert.equal(result.restoreMaximized, false);
  inside(f.window.normal, primary.workArea);
  assert.equal(f.window.normal.width, 1440);
  assert.equal(f.errors.length, 0);
  f.controller.dispose();
});

test('write errors retain dirty state for explicit retry, report error and never loop automatically', async () => {
  let failed = true;
  const f = fixture({persist: async () => {if (failed) throw new Error('disk full');}});
  f.controller.restore(); f.move({x: 100, y: 110, width: 900, height: 750});
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.errors[0].message, 'disk full');
  assert.equal(f.writes.length, 1); assert.equal(f.jobs.size, 0);
  failed = false;
  assert.equal(await f.controller.flush(), true);
  assert.equal(f.writes.length, 2);
  f.controller.dispose();
});

test('serialized flush drains newer movement during a pending write; mutable persist cannot change committed snapshot', async () => {
  let release;
  const barrier = new Promise(resolve => {release = resolve;});
  let count = 0;
  const f = fixture({persist: async value => {if (++count === 1) {await barrier; value.bounds.x = 999;}}});
  f.controller.restore(); f.move({x: 100, y: 100, width: 900, height: 750});
  const first = f.controller.flush();
  f.move({x: 200, y: 100, width: 900, height: 750});
  const second = f.controller.flush();
  assert.equal(first, second);
  release(); await first;
  assert.deepEqual(f.writes.map(value => value.bounds.x), [100, 200]);
  await f.controller.flush(); assert.equal(f.writes.length, 2);
  f.controller.dispose();
});

test('close flushes valid state; dispose removes only own listeners and cancels timers', async () => {
  const f = fixture(); const other = () => {};
  f.window.on('move', other); f.screen.on('display-added', other);
  f.controller.restore(); f.move({x: 120, y: 130, width: 900, height: 750});
  f.window.emit('close'); await f.controller.flush();
  assert.equal(f.writes.length, 1);
  f.move({x: 150, y: 130, width: 900, height: 750});
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.jobs.size, 0);
  assert.deepEqual(f.window.listeners('move'), [other]);
  assert.deepEqual(f.screen.listeners('display-added'), [other]);
  assert.equal(f.window.listenerCount('closed'), 0);
  f.move({x: 250, y: 130, width: 900, height: 750});
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.writes.length, 1);
});
