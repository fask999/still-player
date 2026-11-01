'use strict';

(() => {
  function createReadonlyView() {
    const cache = new WeakMap();
    const deny = () => { throw new TypeError('Renderer state is read-only; use an action'); };
    function readonly(value) {
      if (!value || typeof value !== 'object') return value;
      if (cache.has(value)) return cache.get(value);
      // A separate extensible shell also supports frozen contextBridge DTOs:
      // wrapping their non-configurable properties directly violates Proxy invariants.
      const shell = Array.isArray(value) ? [] : {};
      const proxy = new Proxy(shell, {
        get: (_target, property) => readonly(Reflect.get(value, property)),
        has: (_target, property) => Reflect.has(value, property),
        ownKeys: () => Reflect.ownKeys(value),
        getOwnPropertyDescriptor(_target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
          if (!descriptor) return undefined;
          if (Array.isArray(value) && property === 'length') return {...Reflect.getOwnPropertyDescriptor(shell, 'length'), value: value.length};
          return {configurable: true, enumerable: descriptor.enumerable, writable: false, value: readonly(Reflect.get(value, property))};
        },
        set: deny, deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny, preventExtensions: deny
      });
      cache.set(value, proxy); return proxy;
    }
    return readonly;
  }

  function createRuntime(definitions) {
    const registry = new Map();
    for (const entry of definitions) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.create !== 'function' || registry.has(entry.name)) throw new Error('Invalid or duplicate renderer module');
      registry.set(entry.name, entry.create);
    }
    for (const name of ['timeline', 'libraryState', 'app', 'glass', 'features']) if (!registry.has(name)) throw new Error(`Missing renderer module: ${name}`);
    const extensions = {}, readonly = createReadonlyView(), timeline = registry.get('timeline')(), libraryState = registry.get('libraryState')();
    const app = registry.get('app')({readonly, extensions, libraryState});
    const glass = registry.get('glass')({app, extensions});
    extensions.glass = glass;
    const features = registry.get('features')({app, timeline, glass});
    extensions.features = features;
    let initialized = false;
    return Object.freeze({app, glass, features, timeline, start() { if (initialized) return; initialized = true; glass.init(); return app.start(); }});
  }

  if (typeof module === 'object' && module.exports) module.exports = {createReadonlyView, createRuntime};
  if (typeof window === 'undefined' || !window.document) return;
  let runtime;
  function boot() {
    if (runtime) return runtime;
    runtime = createRuntime(window.StillModules || []);
    window.StillRuntime = runtime;
    // Compatibility for existing read-only diagnostics/smoke hooks. Modules do
    // not read these aliases and are constructed exclusively through factories.
    window.StillApp = runtime.app; window.StillGlass = runtime.glass; window.StillFeatures = runtime.features; window.StillTimeline = runtime.timeline;
    void runtime.start(); return runtime;
  }
  document.addEventListener('DOMContentLoaded', boot, {once: true});
})();
