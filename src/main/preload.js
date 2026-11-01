'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const channels = new Set([
  'app:bootstrap', 'app:window', 'app:openDataFolder', 'app:restoreInfo', 'app:exportDiagnostics',
  'source:status', 'source:select', 'apple:status', 'apple:settings:get', 'apple:settings:update', 'apple:library', 'apple:search', 'apple:authorize', 'apple:pair', 'backend:retry',
  'library:list', 'library:import', 'library:refresh', 'library:remove', 'library:reveal',
  'playlist:create', 'playlist:rename', 'playlist:delete', 'playlist:setTracks', 'playlist:addTracks', 'playlist:removeTracks', 'playlist:removeItem', 'playlist:moveItem',
  'player:state', 'player:context', 'player:spectrum', 'player:play', 'player:toggle', 'player:pause', 'player:stop', 'player:next', 'player:previous', 'player:seek', 'player:volume', 'player:order',
  'queue:list', 'queue:add', 'queue:remove', 'queue:clear', 'audio:outputs', 'audio:select', 'audio:details',
  'settings:get', 'settings:update', 'lyrics:resolve', 'lyrics:search', 'lyrics:preview', 'lyrics:bind', 'lyrics:import', 'lyrics:offset', 'lyrics:unbind'
]);
const events = new Set(['player', 'library', 'settings', 'source', 'error']);
contextBridge.exposeInMainWorld('still', Object.freeze({
  async invoke(channel, payload = {}) {
    if (!channels.has(channel)) throw new Error('Unknown application command');
    const response = await ipcRenderer.invoke(channel, payload);
    if (!response || response.ok !== true) throw new Error(response?.error || 'Application command failed');
    return response.value;
  },
  on(channel, callback) {
    if (!events.has(channel) || typeof callback !== 'function') throw new Error('Invalid application event');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
}));
