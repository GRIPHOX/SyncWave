import { useState } from 'react'
import type { AppSnapshot } from '@shared/types'
import { IconExternal, IconLock, IconX } from './icons'
import { api, cleanError } from './store'

const PORTAL = 'https://discord.com/developers/applications'

export function SetupWizard({ snap, onClose }: { snap: AppSnapshot; onClose: () => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bot = snap.state.bot
  const done = snap.hasToken && bot.status === 'ready'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.setToken(token)
      setToken('')
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim">
      <div className="modal setup" role="dialog" aria-label="Bot setup">
        <button className="icon-btn modal-close" onClick={onClose} title="Close">
          <IconX />
        </button>
        <h2>Connect your Discord bot</h2>
        <p className="lead">
          SyncWave plays audio through a bot you own. It takes about two minutes, once. Never paste your personal
          account token here, only a bot token.
        </p>

        <ol className="steps">
          <li>
            <strong>Create an application</strong>
            <span>
              Open the Developer Portal, click <em>New Application</em> and name it (e.g. "SyncWave").
            </span>
            <button className="btn small ghost" onClick={() => api.openExternal(PORTAL)}>
              Open Developer Portal <IconExternal size={13} />
            </button>
          </li>
          <li>
            <strong>Copy the bot token</strong>
            <span>
              Go to <em>Bot</em> → <em>Reset Token</em> → copy. No privileged intents are needed, so leave them off.
            </span>
          </li>
          <li>
            <strong>Paste it here</strong>
            <form onSubmit={submit} className="token-form">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={snap.hasToken ? 'Paste a new token to replace the saved one' : 'Bot token'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn primary" disabled={busy || token.trim().length < 50}>
                {busy ? 'Connecting…' : 'Save & connect'}
              </button>
            </form>
            <span className="secure">
              <IconLock size={13} /> Encrypted with Windows DPAPI and stored only on this PC. The window never sees
              it again.
            </span>
            {error && <p className="inline-error">{error}</p>}
            {bot.status === 'connecting' && <p className="notice">Logging in…</p>}
            {bot.status === 'ready' && <p className="ok">Logged in as {bot.user?.tag}</p>}
          </li>
          <li className={bot.inviteUrl ? '' : 'muted'}>
            <strong>Invite the bot to your server</strong>
            <span>The link asks only for View Channel, Connect and Speak.</span>
            <button className="btn small ghost" disabled={!bot.inviteUrl} onClick={() => api.openExternal(bot.inviteUrl!)}>
              Open invite link <IconExternal size={13} />
            </button>
          </li>
        </ol>

        <div className="modal-foot">
          <button className={`btn ${done ? 'primary' : 'ghost'}`} onClick={onClose}>
            {done ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
