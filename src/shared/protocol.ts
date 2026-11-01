// Messages between the main process and the engine utilityProcess.
import type { EngineState, Levels, SourceList, SourceSelection } from './types'

export type EngineRequest =
  | { type: 'bot:login'; token: string }
  | { type: 'bot:logout' }
  | { type: 'guilds:refresh' }
  | { type: 'voice:join'; guildId: string; channelId: string }
  | { type: 'voice:leave' }
  | { type: 'sources:list' }
  | { type: 'stream:start'; source: SourceSelection; excludeDiscord: boolean }
  | { type: 'stream:stop' }
  | { type: 'audio:config'; volume: number; muted: boolean; bitrateKbps: number; maxLatencyMs: number }
  | { type: 'shutdown' }

export interface EngineRequestEnvelope {
  id: number
  request: EngineRequest
}

export type EngineMessage =
  | { type: 'reply'; id: number; ok: true; result?: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'state'; state: EngineState }
  | { type: 'levels'; levels: Levels }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'ready' }

export interface EngineReplies {
  'sources:list': SourceList
}

/** Engine start-up configuration, passed as argv (no secrets). */
export interface EngineBootConfig {
  captureExe: string
  hostPid: number
}

// PCM format produced by the capture helper and consumed by the encoder.
export const SAMPLE_RATE = 48000
export const CHANNELS = 2
export const FRAME_MS = 20
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000 // 960 per channel
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2 // 3840 bytes of s16le
