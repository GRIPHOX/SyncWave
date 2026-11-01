// VoiceStreamer: one voice connection + one audio player.
// Handles join/leave, disconnects (moved/kicked/network) and rejoin with backoff.
import { EventEmitter } from 'events'
import type { Readable } from 'stream'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection
} from '@discordjs/voice'
import { ChannelType, type VoiceBasedChannel } from 'discord.js'
import type { VoiceState } from '@shared/types'

interface VoiceEvents {
  state: [VoiceState]
  /** The connection is gone for good (left, kicked, gave up reconnecting). */
  ended: []
  log: ['info' | 'warn' | 'error', string]
}

const MAX_REJOINS = 5

export class VoiceStreamer extends EventEmitter<VoiceEvents> {
  readonly player: AudioPlayer
  private connection: VoiceConnection | null = null
  private channel: VoiceBasedChannel | null = null
  private state: VoiceState = { status: 'idle' }
  private pingTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    // Keep pulling packets even while no connection is subscribed (e.g. mid
    // reconnect) so the queue doesn't build up stale audio.
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Infinity }
    })
    this.player.on('error', (err) => this.emit('log', 'error', `Audio player error: ${err.message}`))
  }

  get current(): VoiceState {
    return this.state
  }

  get connected(): boolean {
    return this.state.status === 'connected'
  }

  private set(patch: Partial<VoiceState> & { status: VoiceState['status'] }, replace = false): void {
    this.state = replace ? patch : { ...this.state, ...patch }
    if (patch.status !== 'error' && !('error' in patch)) delete this.state.error
    this.emit('state', this.state)
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection && this.channel?.guild.id !== channel.guild.id) this.leave(false)
    this.channel = channel
    this.set(
      {
        status: 'connecting',
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        channelId: channel.id,
        channelName: channel.name
      },
      true
    )

    const connection = joinVoiceChannel({
      guildId: channel.guild.id,
      channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    })
    if (this.connection !== connection) {
      this.connection = connection
      this.wire(connection)
      connection.subscribe(this.player)
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000)
    } catch {
      if (this.connection === connection) {
        connection.destroy()
        this.connection = null
        this.set({ status: 'error', error: 'Timed out connecting to the voice channel. Check the bot can Connect there.' })
        this.emit('ended')
      }
      throw new Error('Timed out connecting to the voice channel.')
    }

    if (channel.type === ChannelType.GuildStageVoice) {
      // On a stage the bot joins as audience; ask to become a speaker.
      await channel.guild.members.me?.voice.setSuppressed(false).catch(() => {
        this.emit('log', 'warn', 'Could not become a stage speaker. Give the bot "Mute Members" or invite it to speak.')
      })
    }
  }

  private wire(connection: VoiceConnection): void {
    connection.on('stateChange', async (_old, next) => {
      if (this.connection !== connection) return
      switch (next.status) {
        case VoiceConnectionStatus.Ready:
          connection.rejoinAttempts = 0
          this.set({ status: 'connected' })
          this.refreshChannel()
          this.startPing()
          break
        case VoiceConnectionStatus.Signalling:
        case VoiceConnectionStatus.Connecting:
          if (this.state.status === 'connected') this.set({ status: 'reconnecting' })
          break
        case VoiceConnectionStatus.Disconnected:
          await this.handleDisconnect(connection, next)
          break
        case VoiceConnectionStatus.Destroyed:
          this.stopPing()
          this.connection = null
          if (this.state.status !== 'error') this.set({ status: 'idle' }, true)
          this.emit('ended')
          break
      }
    })
    connection.on('error', (err) => this.emit('log', 'error', `Voice connection error: ${err.message}`))
  }

  private async handleDisconnect(
    connection: VoiceConnection,
    state: { reason: VoiceConnectionDisconnectReason; closeCode?: number }
  ): Promise<void> {
    this.set({ status: 'reconnecting' })
    if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014) {
      // 4014: moved to another channel (will reconnect) or removed from it.
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      } catch {
        if (this.connection === connection) {
          this.set({ status: 'error', error: 'The bot was removed from the voice channel.' })
          connection.destroy()
        }
      }
      return
    }
    if (connection.rejoinAttempts < MAX_REJOINS) {
      const delay = (connection.rejoinAttempts + 1) * 3_000
      this.emit('log', 'warn', `Voice disconnected; rejoining in ${delay / 1000}s`)
      await new Promise((r) => setTimeout(r, delay))
      if (this.connection === connection && connection.state.status === VoiceConnectionStatus.Disconnected)
        connection.rejoin()
    } else if (this.connection === connection) {
      this.set({ status: 'error', error: 'Lost the voice connection and could not reconnect.' })
      connection.destroy()
    }
  }

  /** Follows the bot's actual channel (it may have been moved) and listener count. */
  refreshChannel(): void {
    const me = this.channel?.guild.members.me
    const ch = me?.voice.channel
    if (!ch || !this.connection) return
    this.channel = ch
    const listeners = ch.members.filter((m) => !m.user.bot).size
    if (ch.id !== this.state.channelId || listeners !== this.state.listeners)
      this.set({ status: this.state.status, channelId: ch.id, channelName: ch.name, listeners })
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      const ping = this.connection?.ping.udp ?? this.connection?.ping.ws
      if (ping !== undefined && ping !== this.state.ping) this.set({ status: this.state.status, ping })
    }, 5_000)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  leave(emitIdle = true): void {
    const connection = this.connection
    this.connection = null
    this.channel = null
    this.stopPing()
    connection?.destroy()
    if (emitIdle) this.set({ status: 'idle' }, true)
  }

  play(stream: Readable): void {
    const resource = createAudioResource(stream, { inputType: StreamType.Opus, silencePaddingFrames: 5 })
    this.player.play(resource)
  }

  stopPlayback(): void {
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true)
  }
}
