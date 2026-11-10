'use strict';

const RECT_KEYS = ['x', 'y', 'width', 'height'];
const PLACEMENT_KEYS = ['version', 'bounds', 'maximized', 'displayId', 'workArea', 'scaleFactor'];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function dataRecord(value, allowed, required) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new Error('Invalid desktop window placement');
  }
  return value;
}
function rectangle(value) {
  dataRecord(value, RECT_KEYS, RECT_KEYS);
  if (!RECT_KEYS.every(key => Number.isSafeInteger(value[key])) ||
      Math.abs(value.x) > 10000000 || Math.abs(value.y) > 10000000 ||
      value.width < 1 || value.width > 1000000 || value.height < 1 || value.height > 1000000) {
    throw new Error('Invalid desktop window bounds');
  }
  return {x: value.x, y: value.y, width: value.width, height: value.height};
}
// null means no saved placement. Strict validation also rejects accessors,
// symbols, unknown fields and non-JSON values instead of silently dropping them.
function validateWindowPlacement(value) {
  if (value === null) return null;
  dataRecord(value, PLACEMENT_KEYS, ['version', 'bounds', 'maximized']);
  if (value.version !== 1 || typeof value.maximized !== 'boolean' ||
      (Object.hasOwn(value, 'displayId') && !Number.isSafeInteger(value.displayId)) ||
      (Object.hasOwn(value, 'scaleFactor') && (typeof value.scaleFactor !== 'number' ||
        !Number.isFinite(value.scaleFactor) || value.scaleFactor < 0.25 || value.scaleFactor > 16))) {
    throw new Error('Invalid desktop window placement');
  }
  const result = {version: 1, bounds: rectangle(value.bounds), maximized: value.maximized};
  if (Object.hasOwn(value, 'displayId')) result.displayId = value.displayId;
  if (Object.hasOwn(value, 'workArea')) result.workArea = rectangle(value.workArea);
  if (Object.hasOwn(value, 'scaleFactor')) result.scaleFactor = value.scaleFactor;
  return result;
}
function validSaved(value) {
  try {return validateWindowPlacement(value);} catch {return null;}
}
function normalizeDisplay(display) {
  try {
    const result = {workArea: rectangle(display.workArea)};
    if (Number.isSafeInteger(display.id)) result.id = display.id;
    if (Number.isFinite(display.scaleFactor) && display.scaleFactor >= 0.25 && display.scaleFactor <= 16) result.scaleFactor = display.scaleFactor;
    return result;
  } catch {return null;}
}
function displayList(displays, primaryDisplay) {
  const list = (Array.isArray(displays) ? displays : []).map(normalizeDisplay).filter(Boolean);
  const primary = normalizeDisplay(primaryDisplay);
  if (!list.length) list.push(primary || {workArea: {x: 0, y: 0, width: 1440, height: 940}});
  return {list, primary: list.find(display => primary && display.id === primary.id && same(display.workArea, primary.workArea)) || list[0]};
}
function same(a, b) {return JSON.stringify(a) === JSON.stringify(b);}
function intersection(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function matchingDisplay(bounds, list, primary) {
  let selected = primary, overlap = 0;
  for (const display of list) {
    const next = intersection(bounds, display.workArea);
    if (next > overlap) {selected = display; overlap = next;}
  }
  return {display: selected, overlap};
}
function placementFor(bounds, maximized, display) {
  return {version: 1, bounds: {...bounds}, maximized,
    ...(display.id === undefined ? {} : {displayId: display.id}), workArea: {...display.workArea},
    ...(display.scaleFactor === undefined ? {} : {scaleFactor: display.scaleFactor})};
}
function resolveWindowPlacement({saved, displays, primaryDisplay} = {}) {
  saved = validSaved(saved);
  const {list, primary} = displayList(displays, primaryDisplay);
  const knownDisplay = saved?.displayId === undefined ? undefined : list.find(display => display.id === saved.displayId);
  const matching = saved ? matchingDisplay(saved.bounds, list, primary) : {display: primary, overlap: 0};
  const display = knownDisplay || matching.display, area = display.workArea;
  const minWidth = Math.min(480, area.width), minHeight = Math.min(680, area.height);
  const width = Math.min(area.width, Math.max(minWidth, saved?.bounds.width || 1440));
  const height = Math.min(area.height, Math.max(minHeight, saved?.bounds.height || 940));
  let x = saved?.bounds.x, y = saved?.bounds.y;
  if (!saved || (!knownDisplay && !matching.overlap)) {
    x = area.x + (area.width - width) / 2;
    y = area.y + (area.height - height) / 2;
  } else if (knownDisplay && saved.workArea && !same(area, saved.workArea)) {
    // Keep the normal DIP size and its relative position in the available room.
    // Electron already handles physical pixel scaling; never scale DIP sizes twice.
    const previous = saved.workArea;
    const fraction = (offset, room) => room > 0 ? Math.max(0, Math.min(1, offset / room)) : 0.5;
    x = area.x + fraction(x - previous.x, previous.width - saved.bounds.width) * (area.width - width);
    y = area.y + fraction(y - previous.y, previous.height - saved.bounds.height) * (area.height - height);
  }
  const bounds = {x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y))), width, height};
  const maximized = saved?.maximized === true;
  return {options: {...bounds, minWidth, minHeight}, restoreMaximized: maximized,
    placement: placementFor(bounds, maximized, display)};
}

function createWindowPlacementController({window, screen, getSaved, persist, onError = () => {},
  clock = {setTimeout, clearTimeout}, debounceMs = 250}) {
  if (!window || !screen || typeof getSaved !== 'function' || typeof persist !== 'function' ||
      !Number.isFinite(debounceMs) || debounceMs < 0) throw new Error('Invalid window placement controller dependencies');
  const report = error => {try {onError(error);} catch { /* Error reporting cannot break window shutdown. */ }};
  const topology = () => displayList(screen.getAllDisplays(), screen.getPrimaryDisplay());
  let current = topology(), latest = validSaved(getSaved()), committed = clone(latest);
  let timer = null, disposed = false, applying = false, deferredReflow = false, writing = null, minimum = null;
  const listeners = [];
  const alive = () => !disposed && !window.isDestroyed();
  const usable = () => alive() && !window.isMinimized() && window.isVisible() && !window.isFullScreen?.();
  const normalMatches = bounds => {try {return same(rectangle(window.getNormalBounds()), bounds);} catch {return false;}};
  const cancelTimer = () => {if (timer !== null) clock.clearTimeout(timer); timer = null;};
  function setMinimum(width, height) {
    if (same(minimum, [width, height])) return;
    const wasApplying = applying;
    applying = true;
    try {window.setMinimumSize(width, height); minimum = [width, height];}
    finally {applying = wasApplying;}
  }
  function schedule() {
    cancelTimer();
    timer = clock.setTimeout(() => {timer = null; void flush(false);}, debounceMs);
    timer?.unref?.();
  }
  function capture() {
    if (!usable() || applying || deferredReflow) return clone(latest);
    try {
      // Windows can emit a move/resize before screen's topology event. Ignore
      // that transient rectangle instead of assigning the old window to a new screen.
      if (!same(topology(), current)) return clone(latest);
      const bounds = rectangle(window.getNormalBounds());
      const display = matchingDisplay(bounds, current.list, current.primary).display;
      // Deliberately omit the old display ID: dragging to another screen must win.
      latest = resolveWindowPlacement({saved: placementFor(bounds, window.isMaximized(), display),
        displays: current.list, primaryDisplay: current.primary}).placement;
      return clone(latest);
    } catch (error) {report(error); return clone(latest);}
  }
  function apply(resolved) {
    applying = true;
    try {
      const wasMaximized = window.isMaximized();
      const {minWidth, minHeight, ...bounds} = resolved.options;
      // Lower the old minimum before moving onto a smaller work area.
      setMinimum(minWidth, minHeight);
      if (wasMaximized) window.unmaximize();
      if (!normalMatches(bounds)) window.setBounds(bounds);
      if (resolved.restoreMaximized) window.maximize();
      latest = resolved.placement;
    } finally {applying = false;}
  }
  function restore() {
    if (!alive()) return null;
    try {
      current = topology();
      const result = resolveWindowPlacement({saved: getSaved(), displays: current.list, primaryDisplay: current.primary});
      apply(result);
      return clone(result);
    } catch (error) {report(error); return null;}
  }
  function reflow() {
    if (!alive()) return;
    try {
      const next = topology();
      if (!deferredReflow && same(next, current)) return;
      current = next;
      if (!usable()) {deferredReflow = true; return;}
      deferredReflow = false;
      const resolved = resolveWindowPlacement({saved: latest || getSaved(), displays: current.list, primaryDisplay: current.primary});
      // Adding/changing an unrelated display must not unmaximize this window.
      const {minWidth, minHeight, ...bounds} = resolved.options;
      if (!latest || !normalMatches(bounds) || latest.displayId !== resolved.placement.displayId) apply(resolved);
      else {setMinimum(minWidth, minHeight); latest = resolved.placement;}
      schedule();
    } catch (error) {report(error);}
  }
  function changed() {
    if (applying || !alive()) return;
    try {
      if (deferredReflow) reflow();
      capture();
      if (usable() && latest?.workArea && same(topology(), current)) {
        setMinimum(Math.min(480, latest.workArea.width), Math.min(680, latest.workArea.height));
      }
      schedule();
    } catch (error) {report(error);}
  }
  function flush(sample = true) {
    cancelTimer();
    if (disposed) return writing || Promise.resolve(false);
    if (sample) capture();
    if (writing) return writing;
    writing = (async () => {
      let wrote = false;
      while (!disposed && latest && !same(latest, committed)) {
        const snapshot = clone(latest);
        try {await persist(clone(snapshot));} catch (error) {report(error); return false;}
        committed = snapshot;
        wrote = true;
      }
      return wrote;
    })().finally(() => {writing = null;});
    return writing;
  }
  function listen(emitter, name, callback) {
    emitter.on(name, callback);
    listeners.push(() => emitter.removeListener(name, callback));
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    for (const remove of listeners.splice(0)) remove();
  }
  for (const name of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show']) listen(window, name, changed);
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) listen(screen, name, reflow);
  listen(window, 'close', () => {void flush();});
  listen(window, 'closed', dispose);
  return {restore, capture, flush, dispose};
}

module.exports = {validateWindowPlacement, resolveWindowPlacement, createWindowPlacementController};
