// Types shared by the main process, the engine and the renderer.

/** What the user picked as the audio source. Apps are remembered by exe, since PIDs change. */
export type SourceSelection =
  | { kind: 'system' }
  | { kind: 'app'; pid: number; exe: string; name: string }

/** What the capture helper is actually asked to do. */
export type CaptureTarget =
  | { mode: 'system' }
  | { mode: 'system-exclude'; pid: number }
  | { mode: 'process'; pid: number }

export interface AppSource {
  pid: number
  name: string
  exe: string
  path: string
  title: string
  hasAudioSession: boolean
  active: boolean
  peak: number
}

export interface SourceList {
  processLoopbackSupported: boolean
  osBuild: number
  defaultDevice: string
  apps: AppSource[]
}

export type BotStatus = 'no-token' | 'offline' | 'connecting' | 'ready' | 'error'

export interface BotState {
  status: BotStatus
  user?: { id: string; tag: string; avatarUrl: string | null }
  inviteUrl?: string
  error?: string
}

export interface VoiceChannelInfo {
  id: string
  name: string
  type: 'voice' | 'stage'
  members: number
  userLimit: number
  bitrate: number
  canConnect: boolean
  canSpeak: boolean
}

export interface GuildInfo {
  id: string
  name: string
  iconUrl: string | null
  channels: VoiceChannelInfo[]
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface VoiceState {
  status: VoiceStatus
  guildId?: string
  guildName?: string
  channelId?: string
  channelName?: string
  listeners?: number
  ping?: number
  error?: string
}

export type StreamStatus = 'idle' | 'starting' | 'live' | 'error'

export interface StreamStats {
  encoder: 'libopus' | 'opusscript' | 'none'
  bitrateKbps: number
  queuedMs: number
  droppedFrames: number
  framesSent: number
}

export interface StreamState {
  status: StreamStatus
  source?: SourceSelection
  sourceLabel?: string
  device?: string
  error?: string
  notice?: string
  stats: StreamStats
}

export interface EngineState {
  bot: BotState
  voice: VoiceState
  stream: StreamState
  guilds: GuildInfo[]
}

/** Linear 0..1 levels after volume/mute are applied (what Discord receives). */
export interface Levels {
  peakL: number
  peakR: number
  rmsL: number
  rmsR: number
}

export type EngineLifecycle = 'starting' | 'running' | 'restarting' | 'failed'

export interface Settings {
  audio: {
    volume: number // percent, 0..200
    muted: boolean
    bitrateKbps: number // 32..256
    maxLatencyMs: number // packet queue cap, 40..400
    excludeDiscordFromSystem: boolean
  }
  source: {
    defaultSource: { kind: 'system' } | { kind: 'app'; exe: string; name: string }
    rememberLast: boolean
  }
  discord: {
    autoConnectBot: boolean
    autoJoinLast: boolean
    lastGuildId: string | null
    lastChannelId: string | null
  }
  startup: {
    launchAtLogin: boolean
    startMinimized: boolean
    closeToTray: boolean
  }
}

export interface AppSnapshot {
  engine: EngineLifecycle
  engineError?: string
  state: EngineState
  settings: Settings
  hasToken: boolean
  tokenStorageSecure: boolean
  version: string
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
