// StreamController: capture → frames → gain/mute → meter → Opus → packet queue
// → voice player. Owns the sharing lifecycle and safe source switching.
import { EventEmitter } from 'events'
import { FRAME_MS } from '@shared/protocol'
import type { CaptureTarget, Levels, SourceList, SourceSelection, StreamState } from '@shared/types'
import type { CaptureEngine, CaptureSession } from './capture'
import { createEncoder, type Encoder } from './opus'
import { Framer, GainStage, LevelAccumulator, measure } from './processor'
import { OpusPacketStream } from './pump'

export interface AudioConfig {
  volume: number
  muted: boolean
  bitrateKbps: number
  maxLatencyMs: number
}

/** Minimal surface of VoiceStreamer the controller needs (eases testing). */
export interface PlaybackSink {
  play(stream: OpusPacketStream): void
  stopPlayback(): void
}

const DISCORD_EXES = ['discord.exe', 'discordptb.exe', 'discordcanary.exe']
const READY_TIMEOUT_MS = 8000

export function resolveTarget(selection: SourceSelection, excludeDiscord: boolean, sources: SourceList | null): CaptureTarget {
  if (selection.kind === 'app') return { mode: 'process', pid: selection.pid }
  if (excludeDiscord && sources?.processLoopbackSupported) {
    const discord = sources.apps.find((a) => DISCORD_EXES.includes(a.exe.toLowerCase()))
    if (discord) return { mode: 'system-exclude', pid: discord.pid }
  }
  return { mode: 'system' }
}

export function sourceLabel(selection: SourceSelection, target: CaptureTarget): string {
  if (selection.kind === 'app') return selection.name
  return target.mode === 'system-exclude' ? 'System audio (without Discord)' : 'System audio'
}

interface StreamEvents {
  state: [StreamState]
  levels: [Levels]
  log: ['info' | 'warn' | 'error', string]
}

export class StreamController extends EventEmitter<StreamEvents> {
  private state: StreamState = this.idleState()
  private session: CaptureSession | null = null
  private encoder: Encoder | null = null
  private pump: OpusPacketStream | null = null
  private framer = new Framer()
  private gain = new GainStage()
  private levels = new LevelAccumulator()
  private framesSent = 0
  private lastError = ''
  private readyTimer: NodeJS.Timeout | null = null
  private levelTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private config: AudioConfig = { volume: 100, muted: false, bitrateKbps: 128, maxLatencyMs: 120 }

  constructor(
    private readonly capture: CaptureEngine,
    private readonly sink: PlaybackSink
  ) {
    super()
  }

  get current(): StreamState {
    return this.state
  }

  get live(): boolean {
    return this.state.status === 'live' || this.state.status === 'starting'
  }

  private idleState(notice?: string): StreamState {
    return {
      status: 'idle',
      notice,
      stats: { encoder: 'none', bitrateKbps: this.config?.bitrateKbps ?? 128, queuedMs: 0, droppedFrames: 0, framesSent: 0 }
    }
  }

  private set(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  setConfig(config: AudioConfig): void {
    const bitrateChanged = config.bitrateKbps !== this.config.bitrateKbps
    this.config = config
    this.gain.set(config.volume, config.muted)
    this.pump?.setMaxFrames(config.maxLatencyMs / FRAME_MS)
    if (bitrateChanged && this.encoder) {
      this.encoder.setBitrate(config.bitrateKbps * 1000)
      this.set({ stats: { ...this.state.stats, bitrateKbps: config.bitrateKbps } })
    }
  }

  /** Starts sharing, or switches the source while already sharing. */
  async start(selection: SourceSelection, excludeDiscord: boolean): Promise<void> {
    let sources: SourceList | null = null
    if (selection.kind === 'system' && excludeDiscord) sources = await this.capture.listSources().catch(() => null)
    const target = resolveTarget(selection, excludeDiscord, sources)
    const label = sourceLabel(selection, target)

    // Tear down only the capture side; the encoder, queue and player keep going.
    await this.stopCapture()

    if (!this.pump) {
      this.encoder = createEncoder(this.config.bitrateKbps)
      this.pump = new OpusPacketStream(this.config.maxLatencyMs / FRAME_MS)
      this.framesSent = 0
      this.sink.play(this.pump)
      this.startTimers()
      this.emit('log', 'info', `Opus encoder: ${this.encoder.kind}`)
    }

    this.lastError = ''
    this.framer.reset()
    this.set({
      status: 'starting',
      source: selection,
      sourceLabel: label,
      device: undefined,
      error: undefined,
      notice: undefined,
      stats: { ...this.state.stats, encoder: this.encoder!.kind, bitrateKbps: this.config.bitrateKbps }
    })

    const session = this.capture.start(target)
    this.session = session
    this.readyTimer = setTimeout(() => {
      if (this.session === session && this.state.status === 'starting')
        void this.fail(this.lastError || 'The audio source did not start in time.')
    }, READY_TIMEOUT_MS)

    session.on('data', (chunk) => {
      if (this.session === session) this.onPcm(chunk)
    })
    session.on('ready', (ev) => {
      if (this.session !== session) return
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.set({ status: 'live', device: ev.device })
      this.emit('log', 'info', `Capturing ${label} (${ev.device})`)
    })
    session.on('device-changed', () => this.emit('log', 'info', 'Default output device changed; following it.'))
    session.on('error', (msg) => {
      this.lastError = msg
      this.emit('log', 'error', `Capture: ${msg}`)
    })
    session.on('source-ended', () => {
      if (this.session === session) void this.stop(`${label} closed, so sharing stopped.`)
    })
    session.on('exit', (code) => {
      if (this.session !== session) return
      this.session = null
      if (code === 3) return // source-ended already handled
      void this.fail(this.lastError || `The capture helper stopped unexpectedly (exit code ${code}).`)
    })
  }

  private onPcm(chunk: Buffer): void {
    for (const frame of this.framer.push(chunk)) {
      this.gain.process(frame)
      this.levels.add(measure(frame))
      if (!this.encoder || !this.pump) continue
      try {
        this.pump.pushPacket(this.encoder.encode(frame))
        this.framesSent++
      } catch (err) {
        this.emit('log', 'error', `Opus encode failed: ${(err as Error).message}`)
      }
    }
  }

  private startTimers(): void {
    this.levelTimer = setInterval(() => {
      const l = this.levels.take()
      if (l) this.emit('levels', l)
    }, 50)
    this.statsTimer = setInterval(() => {
      if (!this.pump) return
      const s = this.pump.stats
      this.set({
        stats: {
          ...this.state.stats,
          queuedMs: s.queuedFrames * FRAME_MS,
          droppedFrames: s.droppedFrames,
          framesSent: this.framesSent
        }
      })
    }, 1000)
  }

  private async stopCapture(): Promise<void> {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    const session = this.session
    this.session = null
    if (session) await session.stop()
  }

  private async fail(message: string): Promise<void> {
    await this.teardown()
    this.state = { ...this.idleState(), status: 'error', error: message, source: this.state.source, sourceLabel: this.state.sourceLabel }
    this.emit('state', this.state)
  }

  async stop(notice?: string): Promise<void> {
    const source = this.state.source
    await this.teardown()
    this.state = { ...this.idleState(notice), source }
    this.emit('state', this.state)
  }

  private async teardown(): Promise<void> {
    await this.stopCapture()
    if (this.levelTimer) clearInterval(this.levelTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.levelTimer = this.statsTimer = null
    this.sink.stopPlayback()
    this.pump?.destroy()
    this.pump = null
    this.encoder?.destroy()
    this.encoder = null
    this.levels.take()
    this.emit('levels', { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 })
  }

  /** Synchronous last-resort cleanup (process exit). */
  kill(): void {
    this.session?.kill()
  }
}
