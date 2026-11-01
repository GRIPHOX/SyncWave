// The API the preload script exposes to the renderer as window.syncwave.
import type { AppSnapshot, DeepPartial, Levels, Settings, SourceList, SourceSelection } from './types'

export interface LogEntry {
  time: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface SyncWaveApi {
  getSnapshot(): Promise<AppSnapshot>
  listSources(): Promise<SourceList>
  getSourceIcon(path: string): Promise<string | null>

  setToken(token: string): Promise<void>
  clearToken(): Promise<void>
  connectBot(): Promise<void>
  disconnectBot(): Promise<void>
  refreshGuilds(): Promise<void>

  joinChannel(guildId: string, channelId: string): Promise<void>
  leaveChannel(): Promise<void>

  startSharing(source: SourceSelection): Promise<void>
  stopSharing(): Promise<void>
  setVolume(percent: number): Promise<void>
  setMuted(muted: boolean): Promise<void>

  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>
  getLogs(): Promise<LogEntry[]>

  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  onLevels(cb: (l: Levels) => void): () => void
  onLog(cb: (e: LogEntry) => void): () => void
}

export const IPC = {
  snapshot: 'app:snapshot',
  sourcesList: 'sources:list',
  sourcesIcon: 'sources:icon',
  tokenSet: 'token:set',
  tokenClear: 'token:clear',
  botConnect: 'bot:connect',
  botDisconnect: 'bot:disconnect',
  guildsRefresh: 'guilds:refresh',
  voiceJoin: 'voice:join',
  voiceLeave: 'voice:leave',
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  audioVolume: 'audio:volume',
  audioMuted: 'audio:muted',
  settingsUpdate: 'settings:update',
  openExternal: 'shell:open',
  logs: 'app:logs',
  // main → renderer
  evSnapshot: 'ev:snapshot',
  evLevels: 'ev:levels',
  evLog: 'ev:log'
} as const
