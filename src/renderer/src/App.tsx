import { useCallback, useEffect, useState } from 'react'
import type { SourceList, SourceSelection } from '@shared/types'
import { DiscordPanel } from './DiscordPanel'
import { IconGear, IconX } from './icons'
import { SettingsDrawer } from './Settings'
import { SetupWizard } from './Setup'
import { SourcePanel } from './SourcePanel'
import { Stage } from './Stage'
import { api, cleanError, useSnapshot, useToasts } from './store'

export function App() {
  const snap = useSnapshot()
  const { toasts, push, dismiss } = useToasts()
  const onError = useCallback((m: string) => push('error', m), [push])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [sources, setSources] = useState<SourceList | null>(null)
  const [selection, setSelection] = useState<SourceSelection>({ kind: 'system' })
  const [selectionTouched, setSelectionTouched] = useState(false)

  const refreshSources = useCallback(async () => {
    try {
      setSources(await api.listSources())
    } catch (e) {
      // The engine may still be starting; the next poll retries.
      if (snap?.engine === 'running') onError(cleanError(e))
    }
  }, [snap?.engine, onError])

  // Poll sources so "playing now" stays fresh and closed apps disappear.
  useEffect(() => {
    if (snap?.engine !== 'running') return
    void refreshSources()
    const t = setInterval(refreshSources, 4000)
    return () => clearInterval(t)
  }, [snap?.engine, refreshSources])

  // Preselect the saved default source once the list is known.
  useEffect(() => {
    if (!snap || !sources || selectionTouched) return
    const def = snap.settings.source.defaultSource
    if (def.kind === 'app') {
      const app = sources.apps.find((a) => a.exe.toLowerCase() === def.exe.toLowerCase())
      if (app) setSelection({ kind: 'app', pid: app.pid, exe: app.exe, name: app.name })
    }
  }, [snap, sources, selectionTouched])

  // While live, the selection follows what's actually being shared.
  const streamSource = snap?.state.stream.source
  useEffect(() => {
    if (streamSource && (snap?.state.stream.status === 'live' || snap?.state.stream.status === 'starting'))
      setSelection(streamSource)
  }, [streamSource, snap?.state.stream.status])

  // A selected app that has exited can't be shared; fall back to system audio.
  useEffect(() => {
    if (selection.kind !== 'app' || !sources) return
    if (!sources.apps.some((a) => a.pid === selection.pid)) setSelection({ kind: 'system' })
  }, [sources, selection])

  useEffect(() => {
    if (snap && !snap.hasToken) setSetupOpen(true)
  }, [snap?.hasToken]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <div className="boot">Starting SyncWave…</div>

  const live = snap.state.stream.status === 'live' || snap.state.stream.status === 'starting'

  const choose = async (s: SourceSelection) => {
    setSelection(s)
    setSelectionTouched(true)
    if (live) {
      try {
        await api.startSharing(s) // switches the source without leaving the channel
        push('info', `Now sharing ${s.kind === 'app' ? s.name : 'system audio'}`)
      } catch (e) {
        onError(cleanError(e))
      }
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">SyncWave</span>
          <span className="brand-credit">by Team GRIPHOX</span>
        </div>
        <EnginePill engine={snap.engine} error={snap.engineError} />
        <div className="titlebar-actions">
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <IconGear />
          </button>
        </div>
      </header>

      <main className="layout">
        <DiscordPanel snap={snap} onError={onError} onSetup={() => setSetupOpen(true)} />
        <Stage snap={snap} selection={selection} sources={sources} onError={onError} />
        <SourcePanel
          sources={sources}
          selection={selection}
          live={live}
          excludeDiscord={snap.settings.audio.excludeDiscordFromSystem}
          onChoose={choose}
          onRefresh={refreshSources}
        />
      </main>

      <SettingsDrawer
        open={settingsOpen}
        snap={snap}
        onClose={() => setSettingsOpen(false)}
        onError={onError}
        onSetup={() => {
          setSettingsOpen(false)
          setSetupOpen(true)
        }}
      />
      {setupOpen && <SetupWizard snap={snap} onClose={() => setSetupOpen(false)} />}

      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button className="icon-btn small" onClick={() => dismiss(t.id)} title="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function EnginePill({ engine, error }: { engine: string; error?: string }) {
  if (engine === 'running') return <div className="titlebar-spacer" />
  const text = engine === 'failed' ? error ?? 'Audio engine failed' : engine === 'restarting' ? 'Engine restarting…' : 'Starting engine…'
  return (
    <div className="titlebar-spacer">
      <span className={`pill ${engine === 'failed' ? 'bad' : 'warn'}`}>{text}</span>
    </div>
  )
}
