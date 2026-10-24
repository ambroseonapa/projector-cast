'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cast', {
  listScreens: () => ipcRenderer.invoke('list-screens'),
  prepareCapture: (opts) => ipcRenderer.invoke('prepare-capture', opts),
  platform: () => ipcRenderer.invoke('platform'),
  keepAwake: (on) => ipcRenderer.invoke('keep-awake', on),
  findProjector: (code) => ipcRenderer.invoke('find-projector', code),
  ping: (ip) => ipcRenderer.invoke('ping', ip),
  sendOffer: (ip, code, offer) => ipcRenderer.invoke('send-offer', { ip, code, offer }),
  sendStop: (ip, code) => ipcRenderer.invoke('send-stop', { ip, code }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setCaptureMethod: (method) => ipcRenderer.invoke('set-capture-method', method),
  bundledApkVersion: () => ipcRenderer.invoke('bundled-apk-version'),
  pushUpdate: (ip, code) => ipcRenderer.invoke('push-update', { ip, code }),
  projectorStats: (ip, code) => ipcRenderer.invoke('projector-stats', { ip, code }),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  appInfo: () => ipcRenderer.invoke('app-info'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.invoke('install-update'),
});
