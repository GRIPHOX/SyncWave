import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '@shared/api'
import type { AppSnapshot, DeepPartial, Settings } from '@shared/types'
import { IconKey, IconLock, IconX } from './icons'
import { api, useAction } from './store'

export function SettingsDrawer({
  open,
  snap,
  onClose,
  onError,
  onSetup
}: {
  open: boolean
  snap: AppSnapshot
  onClose: () => void
  onError: (m: string) => void
  onSetup: () => void
}) {
  const s = snap.settings
  const { run } = useAction(onError)
  const save = (patch: DeepPartial<Settings>) => run(() => api.updateSettings(patch))
  const [tab, setTab] = useState<'general' | 'log'>('general')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} aria-hidden={!open}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="drawer-head">
          <h2>Settings</h2>
          <div className="tabs">
            <button className={tab === 'general' ? 'on' : ''} onClick={() => setTab('general')}>
              General
            </button>
            <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
              Activity log
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconX />
          </button>
        </div>

        {tab === 'log' ? (
          <LogView active={open} />
        ) : (
          <div className="drawer-body">
            <section>
              <h3>Audio quality</h3>
              <Field label="Opus bitrate" hint="Discord caps this to the channel's bitrate (96 kbps on most servers, up to 384 with boosts).">
                <select value={s.audio.bitrateKbps} onChange={(e) => save({ audio: { bitrateKbps: Number(e.target.value) } })}>
                  {[64, 96, 128, 160, 192, 256].map((b) => (
                    <option key={b} value={b}>
                      {b} kbps
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Max buffer" hint="Lower = less delay, higher = steadier on a busy PC.">
                <select value={s.audio.maxLatencyMs} onChange={(e) => save({ audio: { maxLatencyMs: Number(e.target.value) } })}>
                  {[60, 80, 120, 200, 300].map((m) => (
                    <option key={m} value={m}>
                      {m} ms
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle
                label="Leave Discord out of system audio"
                hint="Stops voices from your Discord call echoing back into the channel."
                checked={s.audio.excludeDiscordFromSystem}
                onChange={(v) => save({ audio: { excludeDiscordFromSystem: v } })}
              />
            </section>

            <section>
              <h3>Source</h3>
              <Toggle
                label="Remember the last source"
                hint={`Default: ${s.source.defaultSource.kind === 'system' ? 'System audio' : s.source.defaultSource.name}`}
                checked={s.source.rememberLast}
                onChange={(v) => save({ source: { rememberLast: v } })}
              />
              {s.source.defaultSource.kind === 'app' && (
                <button className="btn small ghost" onClick={() => save({ source: { defaultSource: { kind: 'system' } } })}>
                  Reset default to System audio
                </button>
              )}
            </section>

            <section>
              <h3>Discord</h3>
              <Toggle
                label="Connect the bot when SyncWave starts"
                checked={s.discord.autoConnectBot}
                onChange={(v) => save({ discord: { autoConnectBot: v } })}
              />
              <Toggle
                label="Rejoin the last voice channel"
                hint="Joining never starts sharing. You always press Start yourself."
                checked={s.discord.autoJoinLast}
                onChange={(v) => save({ discord: { autoJoinLast: v } })}
              />
              <div className="token-row">
                <IconLock size={16} />
                <div>
                  <strong>Bot token</strong>
                  <span>
                    {snap.hasToken
                      ? `Saved, encrypted with ${snap.tokenStorageSecure ? 'Windows DPAPI' : 'unavailable storage'}`
                      : 'Not set'}
                  </span>
                </div>
                <button className="btn small ghost" onClick={onSetup}>
                  <IconKey size={14} /> {snap.hasToken ? 'Replace' : 'Add'}
                </button>
                {snap.hasToken && (
                  <button
                    className="btn small danger"
                    onClick={() => {
                      if (confirm('Remove the saved bot token? The bot will go offline.')) void run(() => api.clearToken())
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </section>

            <section>
              <h3>Startup</h3>
              <Toggle
                label="Launch SyncWave when Windows starts"
                hint="Only applies to the installed app."
                checked={s.startup.launchAtLogin}
                onChange={(v) => save({ startup: { launchAtLogin: v } })}
              />
              <Toggle
                label="Start minimized to the tray"
                checked={s.startup.startMinimized}
                onChange={(v) => save({ startup: { startMinimized: v } })}
              />
              <Toggle
                label="Closing the window keeps SyncWave in the tray"
                checked={s.startup.closeToTray}
                onChange={(v) => save({ startup: { closeToTray: v } })}
              />
            </section>

            <p className="version">
              SyncWave {snap.version} · Made by <strong className="credit">Team GRIPHOX</strong>
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-text">
        <strong>{label}</strong>
        {hint && <span>{hint}</span>}
      </span>
      {children}
    </label>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field toggle-field">
      <span className="field-text">
        <strong>{label}</strong>
        {hint && <span>{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function LogView({ active }: { active: boolean }) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    void api.getLogs().then(setLogs)
    return api.onLog((e) => setLogs((l) => [...l.slice(-499), e]))
  }, [active])
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, and
  // React would try to call it as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [logs])
  return (
    <div className="log">
      {logs.length === 0 && <p className="empty small">Nothing logged yet.</p>}
      {logs.map((l, i) => (
        <div key={i} className={`log-line ${l.level}`}>
          <time>{new Date(l.time).toLocaleTimeString()}</time>
          <span>{l.message}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}
