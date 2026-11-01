import { useEffect, useState } from 'react'
import type { AppSnapshot, GuildInfo } from '@shared/types'
import { IconExternal, IconKey, IconLeave, IconRefresh, IconStage, IconUsers, IconVoice } from './icons'
import { api, useAction } from './store'

const BOT_LABEL: Record<string, string> = {
  'no-token': 'No bot token',
  offline: 'Offline',
  connecting: 'Connecting…',
  ready: 'Online',
  error: 'Error'
}

const VOICE_LABEL: Record<string, string> = {
  idle: 'Not in a channel',
  connecting: 'Joining…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Disconnected'
}

export function DiscordPanel({
  snap,
  onError,
  onSetup
}: {
  snap: AppSnapshot
  onError: (m: string) => void
  onSetup: () => void
}) {
  const { bot, voice, guilds } = snap.state
  const [guildId, setGuildId] = useState<string | null>(voice.guildId ?? snap.settings.discord.lastGuildId)
  const { busy, run } = useAction(onError)
  const [joining, setJoining] = useState<string | null>(null)

  useEffect(() => {
    if (voice.guildId) setGuildId(voice.guildId)
  }, [voice.guildId])
  useEffect(() => {
    if (guilds.length && !guilds.some((g) => g.id === guildId)) setGuildId(guilds[0].id)
  }, [guilds, guildId])

  const guild: GuildInfo | undefined = guilds.find((g) => g.id === guildId)
  const ready = bot.status === 'ready'

  const join = async (channelId: string) => {
    if (!guild) return
    setJoining(channelId)
    await run(() => api.joinChannel(guild.id, channelId))
    setJoining(null)
  }

  return (
    <aside className="panel discord">
      <div className="panel-head">
        <h2>Discord</h2>
        {ready && (
          <button className="icon-btn" title="Refresh servers" onClick={() => run(() => api.refreshGuilds())}>
            <IconRefresh size={16} />
          </button>
        )}
      </div>

      <div className={`bot-card status-${bot.status}`}>
        <div className="avatar">
          {bot.user?.avatarUrl ? <img src={bot.user.avatarUrl} alt="" /> : <span>{bot.user?.tag?.[0] ?? '?'}</span>}
          <i className="presence" />
        </div>
        <div className="bot-meta">
          <strong>{bot.user?.tag ?? 'Your bot'}</strong>
          <span>{BOT_LABEL[bot.status]}</span>
        </div>
        {bot.status === 'no-token' ? (
          <button className="btn small primary" onClick={onSetup}>
            <IconKey size={14} /> Set up
          </button>
        ) : ready || bot.status === 'connecting' ? (
          <button className="btn small ghost" disabled={busy} onClick={() => run(() => api.disconnectBot())}>
            Disconnect
          </button>
        ) : (
          <button className="btn small primary" disabled={busy} onClick={() => run(() => api.connectBot())}>
            Connect
          </button>
        )}
      </div>
      {bot.error && bot.status !== 'ready' && <p className="inline-error">{bot.error}</p>}

      <div className={`voice-status v-${voice.status}`}>
        <span className="dot" />
        <div>
          <strong>{VOICE_LABEL[voice.status]}</strong>
          {voice.channelName && (
            <span>
              #{voice.channelName} · {voice.guildName}
              {voice.ping !== undefined && voice.status === 'connected' ? ` · ${voice.ping} ms` : ''}
            </span>
          )}
          {voice.error && <span className="err">{voice.error}</span>}
        </div>
        {(voice.status === 'connected' || voice.status === 'reconnecting' || voice.status === 'connecting') && (
          <button className="icon-btn" title="Leave channel" onClick={() => run(() => api.leaveChannel())}>
            <IconLeave size={16} />
          </button>
        )}
      </div>

      {!ready && (
        <p className="panel-note">
          {bot.status === 'no-token'
            ? 'Set up your bot to see your servers and voice channels here.'
            : bot.status === 'connecting'
              ? 'Connecting to Discord…'
              : 'Connect the bot to see your servers and voice channels.'}
        </p>
      )}

      {ready && guilds.length === 0 && (
        <div className="empty">
          <p>Your bot isn't in any server yet.</p>
          {bot.inviteUrl && (
            <button className="btn primary" onClick={() => api.openExternal(bot.inviteUrl!)}>
              Invite the bot <IconExternal size={14} />
            </button>
          )}
        </div>
      )}

      {ready && guilds.length > 0 && (
        <>
          <div className="guilds" role="tablist" aria-label="Servers">
            {guilds.map((g) => (
              <button
                key={g.id}
                role="tab"
                aria-selected={g.id === guildId}
                className={`guild ${g.id === guildId ? 'active' : ''} ${g.id === voice.guildId ? 'joined' : ''}`}
                title={g.name}
                onClick={() => setGuildId(g.id)}
              >
                {g.iconUrl ? <img src={g.iconUrl} alt="" /> : <span>{initials(g.name)}</span>}
              </button>
            ))}
          </div>
          <div className="guild-name">{guild?.name}</div>
          <ul className="channels">
            {guild?.channels.length === 0 && <li className="empty small">No voice channels the bot can see.</li>}
            {guild?.channels.map((c) => {
              const here = voice.channelId === c.id && voice.status !== 'idle'
              const blocked = !c.canConnect || !c.canSpeak
              return (
                <li key={c.id}>
                  <button
                    className={`channel ${here ? 'here' : ''}`}
                    disabled={blocked || joining !== null}
                    title={blocked ? (!c.canConnect ? 'Bot is missing Connect permission (or channel full)' : 'Bot is missing Speak permission') : `Join #${c.name}`}
                    onClick={() => join(c.id)}
                  >
                    {c.type === 'stage' ? <IconStage size={16} /> : <IconVoice size={16} />}
                    <span className="cname">{c.name}</span>
                    {joining === c.id ? (
                      <span className="spinner" />
                    ) : (
                      <span className="members">
                        <IconUsers size={13} />
                        {c.members}
                        {c.userLimit ? `/${c.userLimit}` : ''}
                      </span>
                    )}
                    {blocked && <span className="lock">no access</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {bot.inviteUrl && (
            <button className="link" onClick={() => api.openExternal(bot.inviteUrl!)}>
              Add the bot to another server <IconExternal size={12} />
            </button>
          )}
        </>
      )}
    </aside>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
}
