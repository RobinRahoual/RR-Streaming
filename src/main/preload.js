'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('rr', {
  version: () => ipcRenderer.invoke('app:version'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  tmdb: (path, params) => ipcRenderer.invoke('tmdb:get', path, params),

  sources: {
    state: () => ipcRenderer.invoke('sources:state'),
    addSubscription: (url) => ipcRenderer.invoke('sources:addSubscription', url),
    sync: (id) => ipcRenderer.invoke('sources:sync', id),
    syncAll: () => ipcRenderer.invoke('sources:syncAll'),
    toggleSubscription: (id, enabled) => ipcRenderer.invoke('sources:toggleSubscription', id, enabled),
    removeSubscription: (id) => ipcRenderer.invoke('sources:removeSubscription', id),
    toggleProvider: (id, enabled) => ipcRenderer.invoke('sources:toggleProvider', id, enabled),
    importDocument: (raw) => ipcRenderer.invoke('sources:import', raw),
    onChange: on('sources:changed'),
    availability: (list, query) => ipcRenderer.invoke('sources:availability', list, query),
    onAvailabilityDone: on('availability:done'),
    cancelAvailability: () => ipcRenderer.invoke('sources:availabilityCancel'),
    diagnose: (list, query) => ipcRenderer.invoke('sources:diagnose', list, query),
    onAvailability: on('availability:result'),
  },

  companion: {
    api: (method, path, raw) => ipcRenderer.invoke('companion:api', method, path, raw),
    start: () => ipcRenderer.invoke('companion:start'),
    stop: () => ipcRenderer.invoke('companion:stop'),
  },

  stream: {
    prefetch: (media, slot) => ipcRenderer.invoke('stream:prefetch', media, slot),
    status: (media) => ipcRenderer.invoke('stream:status', media),
    onStatus: on('stream:status'),
  },

  player: {
    resolve: (media, opts) => ipcRenderer.invoke('player:resolve', media, opts),
    cancel: () => ipcRenderer.invoke('player:cancel'),
    stop: () => ipcRenderer.invoke('player:stop'),
    onProgress: on('player:progress'),
  },

  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    state: () => ipcRenderer.invoke('updater:state'),
    onState: on('updater:state'),
  },

  window: {
    toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
    setFullscreen: (v) => ipcRenderer.invoke('window:setFullscreen', v),
  },
});
