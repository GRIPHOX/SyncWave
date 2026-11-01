import { useEffect, useMemo, useState } from 'react'
import type { AppSource, SourceList, SourceSelection } from '@shared/types'
import { IconApp, IconMonitor, IconRefresh, IconSearch } from './icons'
import { api } from './store'

const iconCache = new Map<string, string | null>()

function AppIcon({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(iconCache.get(path) ?? null)
  useEffect(() => {
    if (!path || iconCache.has(path)) return
    let alive = true
    void api.getSourceIcon(path).then((url) => {
      iconCache.set(path, url)
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [path])
  return src ? <img src={src} alt="" /> : <IconApp size={20} />
}

export function SourcePanel({
  sources,
  selection,
  live,
  excludeDiscord,
  onChoose,
  onRefresh
}: {
  sources: SourceList | null
  selection: SourceSelection
  live: boolean
  excludeDiscord: boolean
  onChoose: (s: SourceSelection) => void
  onRefresh: () => void
}) {
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  const { audible, others } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const apps = (sources?.apps ?? []).filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q) || a.title.toLowerCase().includes(q)
    )
    return { audible: apps.filter((a) => a.hasAudioSession), others: apps.filter((a) => !a.hasAudioSession) }
  }, [sources, query])

  const perApp = sources?.processLoopbackSupported ?? true
  const isSel = (a: AppSource) => selection.kind === 'app' && selection.pid === a.pid

  const row = (a: AppSource) => (
    <li key={a.pid}>
      <button
        className={`source ${isSel(a) ? 'selected' : ''}`}
        disabled={!perApp}
        onClick={() => onChoose({ kind: 'app', pid: a.pid, exe: a.exe, name: a.name })}
        title={a.title || a.exe}
      >
        <span className="src-icon">
          <AppIcon path={a.path} />
        </span>
        <span className="src-text">
          <strong>{a.name}</strong>
          <span>{a.title && a.title !== a.name ? a.title : a.exe}</span>
        </span>
        {a.active && a.peak > 0.001 ? (
          <span className="playing" title="Playing audio now">
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </button>
    </li>
  )

  return (
    <aside className="panel sources">
      <div className="panel-head">
        <h2>Audio source</h2>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}>
          <IconRefresh size={16} />
        </button>
      </div>

      <button
        className={`source system ${selection.kind === 'system' ? 'selected' : ''}`}
        onClick={() => onChoose({ kind: 'system' })}
      >
        <span className="src-icon system-icon">
          <IconMonitor size={20} />
        </span>
        <span className="src-text">
          <strong>System audio</strong>
          <span>
            {sources?.defaultDevice || 'Default output'}
            {excludeDiscord && perApp ? ' · Discord excluded' : ''}
          </span>
        </span>
      </button>

      {!perApp && (
        <p className="inline-error">
          Per-app capture needs Windows 10 version 2004 or newer (this PC is build {sources?.osBuild}).
        </p>
      )}

      <label className="search">
        <IconSearch size={15} />
        <input placeholder="Find an app" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </label>

      <div className="source-scroll">
        <div className="group-label">Apps with audio</div>
        <ul className="source-list">
          {audible.length === 0 && <li className="empty small">{sources ? 'No app has opened audio yet.' : 'Looking for apps…'}</li>}
          {audible.map(row)}
        </ul>

        <button className="group-label toggle" onClick={() => setShowAll((v) => !v)}>
          Other open apps ({others.length}) <span>{showAll ? '−' : '+'}</span>
        </button>
        {showAll && <ul className="source-list">{others.map(row)}</ul>}
      </div>

      {live && <p className="hint">Picking another source switches the stream without leaving the channel.</p>}
    </aside>
  )
}
