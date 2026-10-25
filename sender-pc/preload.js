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
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openReleases: () => ipcRenderer.invoke('open-releases'),
  vddStatus: () => ipcRenderer.invoke('vdd-status'),
  vddInstall: () => ipcRenderer.invoke('vdd-install'),
  vddSet: (on) => ipcRenderer.invoke('vdd-set', on),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  remoteKey: (key) => ipcRenderer.invoke('remote-key', key),
  previewInput: (input) => ipcRenderer.invoke('preview-input', input),
  appAudioSupported: () => ipcRenderer.invoke('app-audio-supported'),
  appAudioStart: (target, mute) => ipcRenderer.invoke('app-audio-start', { ...target, mute }),
  onAppAudioShared: (cb) => ipcRenderer.on('app-audio-shared', (_e, names) => cb(names)),
  appAudioStop: () => ipcRenderer.invoke('app-audio-stop'),
  onAppAudio: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('app-audio', h);
    return () => ipcRenderer.removeListener('app-audio', h);
  },
  onAppAudioEnded: (cb) => ipcRenderer.on('app-audio-ended', (_e, why) => cb(why)),
});
