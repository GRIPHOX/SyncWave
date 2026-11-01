// Preload: the only bridge between the sandboxed renderer and the main process.
// It exposes a fixed set of functions; no ipcRenderer or Node API leaks out.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SyncWaveApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SyncWaveApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  listSources: () => ipcRenderer.invoke(IPC.sourcesList),
  getSourceIcon: (path) => ipcRenderer.invoke(IPC.sourcesIcon, path),
  setToken: (token) => ipcRenderer.invoke(IPC.tokenSet, token),
  clearToken: () => ipcRenderer.invoke(IPC.tokenClear),
  connectBot: () => ipcRenderer.invoke(IPC.botConnect),
  disconnectBot: () => ipcRenderer.invoke(IPC.botDisconnect),
  refreshGuilds: () => ipcRenderer.invoke(IPC.guildsRefresh),
  joinChannel: (guildId, channelId) => ipcRenderer.invoke(IPC.voiceJoin, guildId, channelId),
  leaveChannel: () => ipcRenderer.invoke(IPC.voiceLeave),
  startSharing: (source) => ipcRenderer.invoke(IPC.streamStart, source),
  stopSharing: () => ipcRenderer.invoke(IPC.streamStop),
  setVolume: (percent) => ipcRenderer.invoke(IPC.audioVolume, percent),
  setMuted: (muted) => ipcRenderer.invoke(IPC.audioMuted, muted),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  getLogs: () => ipcRenderer.invoke(IPC.logs),
  onSnapshot: (cb) => subscribe(IPC.evSnapshot, cb),
  onLevels: (cb) => subscribe(IPC.evLevels, cb),
  onLog: (cb) => subscribe(IPC.evLog, cb)
}

contextBridge.exposeInMainWorld('syncwave', api)
