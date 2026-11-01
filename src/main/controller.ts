// AppController: the main-process brain. Owns settings, the token vault and the
// engine host, keeps the UI snapshot, and implements every user action.
import { EventEmitter } from 'events'
import type { LogEntry } from '@shared/api'
import type { AppSnapshot, EngineState, Levels, SourceList, SourceSelection } from '@shared/types'
import { mergeSettings, validateBotToken } from '@shared/validate'
import type { EngineHost } from './engineHost'
import type { SettingsStore } from './settings'
import type { TokenVault } from './tokenVault'

interface ControllerEvents {
  snapshot: [AppSnapshot]
  levels: [Levels]
  log: [LogEntry]
}

const EMPTY_STATE: EngineState = {
  bot: { status: 'offline' },
  voice: { status: 'idle' },
  stream: { status: 'idle', stats: { encoder: 'none', bitrateKbps: 128, queuedMs: 0, droppedFrames: 0, framesSent: 0 } },
  guilds: []
}

export class AppController extends EventEmitter<ControllerEvents> {
  private state: EngineState = EMPTY_STATE
  private logs: LogEntry[] = []
  private knownIconPaths = new Set<string>()
  private autoJoinDone = false
  private pushTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly engine: EngineHost,
    private readonly settings: SettingsStore,
    private readonly vault: TokenVault,
    private readonly version: string
  ) {
    super()
    engine.on('state', (s) => {
      const wasReady = this.state.bot.status === 'ready'
      this.state = s
      this.push()
      if (!wasReady && s.bot.status === 'ready') void this.maybeAutoJoin()
    })
    engine.on('levels', (l) => this.emit('levels', l))
    engine.on('lifecycle', () => this.push())
    engine.on('log', (level, message) => this.log(level, message))
    engine.on('ready', () => void this.onEngineReady())
  }

  log(level: LogEntry['level'], message: string): void {
    const entry = { time: Date.now(), level, message }
    this.logs.push(entry)
    if (this.logs.length > 500) this.logs.shift()
    this.emit('log', entry)
  }

  getLogs(): LogEntry[] {
    return this.logs
  }

  snapshot(): AppSnapshot {
    const state = { ...this.state }
    if (!this.vault.has()) state.bot = { status: 'no-token' }
    return {
      engine: this.engine.lifecycle,
      engineError: this.engine.lastError,
      state,
      settings: this.settings.get(),
      hasToken: this.vault.has(),
      tokenStorageSecure: this.vault.secure,
      version: this.version
    }
  }

  private push(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.emit('snapshot', this.snapshot())
    }, 16)
  }

  private async onEngineReady(): Promise<void> {
    await this.sendAudioConfig()
    const s = this.settings.get()
    if (this.vault.has() && (s.discord.autoConnectBot || this.wantBot)) {
      await this.connectBot().catch((e) => this.log('error', (e as Error).message))
    } else {
      await this.engine.request({ type: 'bot:logout' }).catch(() => {})
    }
  }

  /** Set when the user connected manually, so an engine restart reconnects too. */
  private wantBot = false

  private sendAudioConfig(): Promise<unknown> {
    const a = this.settings.get().audio
    return this.engine.request({
      type: 'audio:config',
      volume: a.volume,
      muted: a.muted,
      bitrateKbps: a.bitrateKbps,
      maxLatencyMs: a.maxLatencyMs
    })
  }

  private async maybeAutoJoin(): Promise<void> {
    const d = this.settings.get().discord
    if (this.autoJoinDone || !d.autoJoinLast || !d.lastGuildId || !d.lastChannelId) return
    this.autoJoinDone = true
    await this.joinChannel(d.lastGuildId, d.lastChannelId).catch((e) =>
      this.log('warn', `Auto-join failed: ${(e as Error).message}`)
    )
  }

  // ---------------------------------------------------------------- actions

  async setToken(raw: unknown): Promise<void> {
    const token = validateBotToken(raw)
    this.vault.save(token)
    this.log('info', 'Bot token saved (encrypted).')
    this.push()
    await this.connectBot()
  }

  async clearToken(): Promise<void> {
    this.wantBot = false
    await this.engine.request({ type: 'bot:logout' }).catch(() => {})
    this.vault.clear()
    this.log('info', 'Bot token removed.')
    this.push()
  }

  async connectBot(): Promise<void> {
    const token = this.vault.read()
    if (!token) throw new Error('No bot token saved (or it could not be decrypted). Enter it again.')
    this.wantBot = true
    await this.engine.request({ type: 'bot:login', token })
  }

  async disconnectBot(): Promise<void> {
    this.wantBot = false
    await this.engine.request({ type: 'bot:logout' })
  }

  refreshGuilds(): Promise<unknown> {
    return this.engine.request({ type: 'guilds:refresh' })
  }

  async joinChannel(guildId: string, channelId: string): Promise<void> {
    await this.engine.request({ type: 'voice:join', guildId, channelId })
    this.settings.update({ discord: { lastGuildId: guildId, lastChannelId: channelId } })
    this.push()
  }

  async leaveChannel(): Promise<void> {
    await this.engine.request({ type: 'voice:leave' })
  }

  async listSources(): Promise<SourceList> {
    const list = await this.engine.request<SourceList>({ type: 'sources:list' })
    for (const app of list.apps) if (app.path) this.knownIconPaths.add(app.path.toLowerCase())
    return list
  }

  /** Icons are only served for executables the helper reported as sources. */
  isKnownIconPath(path: string): boolean {
    return this.knownIconPaths.has(path.toLowerCase())
  }

  async startSharing(source: SourceSelection): Promise<void> {
    const s = this.settings.get()
    await this.engine.request({
      type: 'stream:start',
      source,
      excludeDiscord: s.audio.excludeDiscordFromSystem
    })
    if (s.source.rememberLast) {
      this.settings.update({
        source: {
          defaultSource: source.kind === 'app' ? { kind: 'app', exe: source.exe, name: source.name } : { kind: 'system' }
        }
      })
      this.push()
    }
  }

  /** Start sharing the saved default source (tray / shortcut). */
  async startDefault(): Promise<void> {
    const def = this.settings.get().source.defaultSource
    if (def.kind === 'system') return this.startSharing({ kind: 'system' })
    const list = await this.listSources()
    const app = list.apps.find((a) => a.exe.toLowerCase() === def.exe.toLowerCase())
    if (!app) throw new Error(`${def.name} is not running.`)
    return this.startSharing({ kind: 'app', pid: app.pid, exe: app.exe, name: app.name })
  }

  stopSharing(): Promise<unknown> {
    return this.engine.request({ type: 'stream:stop' })
  }

  async setAudio(patch: { volume?: number; muted?: boolean }): Promise<void> {
    this.settings.update({ audio: patch })
    this.push()
    await this.sendAudioConfig()
  }

  async updateSettings(patch: unknown): Promise<ReturnType<SettingsStore['get']>> {
    const before = this.settings.get()
    // Validate fully before touching anything.
    mergeSettings(before, patch)
    const after = this.settings.update(patch)
    if (JSON.stringify(before.audio) !== JSON.stringify(after.audio)) await this.sendAudioConfig().catch(() => {})
    this.emit('snapshot', this.snapshot())
    return after
  }

  get streamLive(): boolean {
    return this.state.stream.status === 'live' || this.state.stream.status === 'starting'
  }

  get voiceConnected(): boolean {
    return this.state.voice.status === 'connected'
  }
}
