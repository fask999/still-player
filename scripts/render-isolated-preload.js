'use strict';

// Used only by render-isolated.js in its own hidden offscreen fixture window.
// No production preload, Node APIs, renderer paths or write bridge is exposed.
const {contextBridge, ipcRenderer} = require('electron');
const events = new Set(['library', 'player', 'settings', 'source', 'error']);
contextBridge.exposeInMainWorld('still', Object.freeze({
  invoke(channel, payload = {}) {return ipcRenderer.invoke('isolated-render:fixture-read', {channel, payload});},
  on(channel, callback) {
    if (!events.has(channel) || typeof callback !== 'function') throw new Error('Invalid isolated fixture subscription');
    // Initial scenes are static. No engine/event source exists in this harness.
    return () => {};
  }
}));
