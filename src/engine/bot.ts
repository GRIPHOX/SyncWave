// BotService: the discord.js client. Login, guild + voice channel discovery,
// gateway status. Only non-privileged intents are used.
import { EventEmitter } from 'events'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type VoiceBasedChannel
} from 'discord.js'
import { buildInviteUrl } from '@shared/validate'
import type { BotState, GuildInfo, VoiceChannelInfo } from '@shared/types'

export function describeLoginError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string })?.code
  if (code === 'TokenInvalid' || /invalid token/i.test(msg))
    return 'Discord rejected the token. Reset it in Developer Portal → Bot and paste the new one.'
  if (code === 'DisallowedIntents' || /disallowed intents/i.test(msg))
    return 'Discord refused the requested intents.'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(msg))
    return 'Could not reach Discord. Check your internet connection.'
  return msg
}

export function voiceChannelInfo(channel: VoiceBasedChannel): VoiceChannelInfo {
  const me = channel.guild.members.me
  const perms = me ? channel.permissionsFor(me) : null
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type === ChannelType.GuildStageVoice ? 'stage' : 'voice',
    members: channel.members.filter((m) => !m.user.bot).size,
    userLimit: channel.userLimit,
    bitrate: channel.bitrate,
    canConnect: !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]) && channel.joinable,
    canSpeak: !!perms?.has(PermissionFlagsBits.Speak)
  }
}

export function guildInfo(guild: Guild): GuildInfo {
  const channels = [...guild.channels.cache.values()]
    .filter((c): c is VoiceBasedChannel => c.isVoiceBased())
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(voiceChannelInfo)
  return { id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 64 }), channels }
}

interface BotEvents {
  state: [BotState]
  guilds: [GuildInfo[]]
  /** Voice states in a guild changed (member counts, the bot being moved). */
  voiceUpdate: [string]
  log: ['info' | 'warn' | 'error', string]
}

export class BotService extends EventEmitter<BotEvents> {
  client: Client | null = null
  private state: BotState = { status: 'no-token' }
  private guildTimer: NodeJS.Timeout | null = null

  get current(): BotState {
    return this.state
  }

  private set(state: BotState): void {
    this.state = state
    this.emit('state', state)
  }

  async login(token: string): Promise<void> {
    await this.logout(false)
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] })
    this.client = client
    this.set({ status: 'connecting' })

    client.once(Events.ClientReady, (c) => {
      this.set({
        status: 'ready',
        user: { id: c.user.id, tag: c.user.tag, avatarUrl: c.user.displayAvatarURL({ size: 64 }) },
        inviteUrl: buildInviteUrl(c.application.id)
      })
      this.emit('log', 'info', `Bot logged in as ${c.user.tag}`)
      this.publishGuilds()
    })
    const refresh = (): void => this.scheduleGuilds()
    client.on(Events.GuildCreate, refresh)
    client.on(Events.GuildDelete, refresh)
    client.on(Events.GuildUpdate, refresh)
    client.on(Events.ChannelCreate, refresh)
    client.on(Events.ChannelDelete, refresh)
    client.on(Events.ChannelUpdate, refresh)
    client.on(Events.GuildRoleUpdate, refresh)
    client.on(Events.GuildMemberUpdate, refresh)
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      refresh()
      this.emit('voiceUpdate', newState.guild.id ?? oldState.guild.id)
    })
    client.on(Events.ShardDisconnect, () => {
      if (this.client === client) this.set({ ...this.state, status: 'connecting', error: 'Gateway disconnected' })
    })
    client.on(Events.ShardReconnecting, () => {
      if (this.client === client) this.set({ ...this.state, status: 'connecting' })
    })
    client.on(Events.ShardResume, () => {
      if (this.client === client) this.set({ ...this.state, status: 'ready', error: undefined })
    })
    client.on(Events.ShardReady, () => {
      if (this.client === client && this.state.user) this.set({ ...this.state, status: 'ready', error: undefined })
    })
    client.on(Events.Error, (err) => this.emit('log', 'error', `Discord client error: ${err.message}`))
    client.on(Events.Warn, (msg) => this.emit('log', 'warn', msg))

    try {
      await client.login(token)
    } catch (err) {
      if (this.client === client) {
        this.client = null
        client.destroy().catch(() => {})
        this.set({ status: 'error', error: describeLoginError(err) })
      }
      throw new Error(describeLoginError(err))
    }
  }

  async logout(clearState = true): Promise<void> {
    const client = this.client
    this.client = null
    if (this.guildTimer) clearTimeout(this.guildTimer)
    if (client) {
      client.removeAllListeners()
      await client.destroy().catch(() => {})
    }
    if (clearState) {
      this.set({ status: 'offline' })
      this.emit('guilds', [])
    }
  }

  markNoToken(): void {
    this.set({ status: 'no-token' })
  }

  private scheduleGuilds(): void {
    if (this.guildTimer) return
    this.guildTimer = setTimeout(() => {
      this.guildTimer = null
      this.publishGuilds()
    }, 250)
  }

  publishGuilds(): void {
    this.emit('guilds', this.guilds())
  }

  guilds(): GuildInfo[] {
    if (!this.client?.isReady()) return []
    return [...this.client.guilds.cache.values()].map(guildInfo).sort((a, b) => a.name.localeCompare(b.name))
  }

  getVoiceChannel(guildId: string, channelId: string): VoiceBasedChannel {
    if (!this.client?.isReady()) throw new Error('The bot is not connected to Discord.')
    const guild = this.client.guilds.cache.get(guildId)
    if (!guild) throw new Error('The bot is not in that server any more.')
    const channel = guild.channels.cache.get(channelId)
    if (!channel?.isVoiceBased()) throw new Error('That voice channel no longer exists.')
    return channel
  }
}
