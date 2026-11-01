import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, Levels, SourceList, SourceSelection } from '@shared/types'
import { IconMonitor, IconMuted, IconSpeaker } from './icons'
import { api, toDb, useAction, useLevelsRef } from './store'

const MIN_DB = -60

export function Stage({
  snap,
  selection,
  sources,
  onError
}: {
  snap: AppSnapshot
  selection: SourceSelection
  sources: SourceList | null
  onError: (m: string) => void
}) {
  const levels = useLevelsRef()
  const { stream, voice, bot } = snap.state
  const { busy, run } = useAction(onError)
  const audio = snap.settings.audio
  const [volume, setVolume] = useState(audio.volume)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setVolume(audio.volume)
  }, [audio.volume])

  const live = stream.status === 'live'
  const starting = stream.status === 'starting'
  const connected = voice.status === 'connected' || voice.status === 'reconnecting'
  const canStart = connected && bot.status === 'ready' && snap.engine === 'running'

  const selName = selection.kind === 'app' ? selection.name : 'System audio'
  const selApp = selection.kind === 'app' ? sources?.apps.find((a) => a.pid === selection.pid) : undefined

  let hint = ''
  if (bot.status === 'no-token') hint = 'Add your bot token to get started.'
  else if (bot.status === 'error') hint = 'The bot could not connect. See the error on the left.'
  else if (bot.status !== 'ready') hint = 'Waiting for the bot to come online…'
  else if (!connected) hint = 'Pick a voice channel on the left, then start sharing.'
  else if (!live && !starting) hint = `Ready to share ${selName} to #${voice.channelName}.`

  const toggle = () =>
    run(() => (live || starting ? api.stopSharing() : api.startSharing(selection)))

  const commitVolume = (v: number) => {
    dragging.current = false
    void run(() => api.setVolume(v))
  }

  return (
    <section className="stage">
      <div className="now">
        <span className={`live-badge ${live ? 'on' : starting ? 'wait' : ''}`}>
          {live ? 'LIVE' : starting ? 'STARTING' : 'OFF AIR'}
        </span>
        <h1>{live || starting ? stream.sourceLabel ?? selName : selName}</h1>
        <p className="sub">
          {live
            ? `Streaming to #${voice.channelName} · ${voice.guildName}`
            : selApp?.title && selApp.title !== selName
              ? selApp.title
              : selection.kind === 'system'
                ? sources?.defaultDevice ?? 'Default output device'
                : ''}
        </p>
      </div>

      <div className="orb-wrap">
        <Visualizer levels={levels} active={live} muted={audio.muted} />
        <button
          className={`orb ${live ? 'live' : ''} ${starting ? 'starting' : ''}`}
          disabled={busy || (!live && !starting && !canStart)}
          onClick={toggle}
          aria-pressed={live}
        >
          <span className="orb-icon">{selection.kind === 'system' ? <IconMonitor size={30} /> : <IconSpeaker size={30} />}</span>
          <span className="orb-label">{live ? 'Stop sharing' : starting ? 'Starting…' : 'Start sharing'}</span>
        </button>
      </div>

      {hint && <p className="stage-hint">{hint}</p>}
      {stream.error && <p className="inline-error center">{stream.error}</p>}
      {stream.notice && !live && <p className="notice center">{stream.notice}</p>}

      <div className="controls">
        <Meter levels={levels} active={live} />

        <div className="volume-row">
          <button
            className={`mute ${audio.muted ? 'on' : ''}`}
            onClick={() => run(() => api.setMuted(!audio.muted))}
            title={audio.muted ? 'Unmute' : 'Mute'}
            aria-pressed={audio.muted}
          >
            {audio.muted ? <IconMuted /> : <IconSpeaker />}
            <span>{audio.muted ? 'Muted' : 'Mute'}</span>
          </button>
          <input
            type="range"
            className="slider"
            min={0}
            max={200}
            step={1}
            value={volume}
            style={{ ['--fill' as string]: `${volume / 2}%` }}
            onPointerDown={() => (dragging.current = true)}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVolume(v)
              void api.setVolume(v).catch(() => {})
            }}
            onPointerUp={(e) => commitVolume(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitVolume(Number((e.target as HTMLInputElement).value))}
            aria-label="Volume"
          />
          <span className="vol-value">{volume}%</span>
        </div>

        <dl className="stats">
          <div>
            <dt>Bitrate</dt>
            <dd>{stream.stats.bitrateKbps} kbps</dd>
          </div>
          <div>
            <dt>Buffer</dt>
            <dd>{live ? `${stream.stats.queuedMs} ms` : '—'}</dd>
          </div>
          <div>
            <dt>Ping</dt>
            <dd>{voice.ping !== undefined && connected ? `${voice.ping} ms` : '—'}</dd>
          </div>
          <div>
            <dt>Listeners</dt>
            <dd>{connected ? voice.listeners ?? 0 : '—'}</dd>
          </div>
          <div>
            <dt>Dropped</dt>
            <dd>{live ? stream.stats.droppedFrames : '—'}</dd>
          </div>
          <div>
            <dt>Encoder</dt>
            <dd>{stream.stats.encoder === 'none' ? '—' : stream.stats.encoder}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

/** Stereo peak/RMS meter with peak hold, drawn on a canvas at display refresh rate. */
function Meter({ levels, active }: { levels: React.RefObject<Levels>; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    const shown = { l: MIN_DB, r: MIN_DB, rl: MIN_DB, rr: MIN_DB, hl: MIN_DB, hr: MIN_DB, htl: 0, htr: 0 }
    let raf = 0
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== w * dpr) {
        c.width = w * dpr
        c.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const lv = levels.current
      const fall = 1.2 // dB per frame
      const target = (v: number) => Math.max(MIN_DB, toDb(v))
      shown.l = Math.max(target(lv.peakL), shown.l - fall)
      shown.r = Math.max(target(lv.peakR), shown.r - fall)
      shown.rl = Math.max(target(lv.rmsL), shown.rl - fall)
      shown.rr = Math.max(target(lv.rmsR), shown.rr - fall)
      if (shown.l >= shown.hl) [shown.hl, shown.htl] = [shown.l, t]
      else if (t - shown.htl > 1200) shown.hl = Math.max(MIN_DB, shown.hl - 0.6)
      if (shown.r >= shown.hr) [shown.hr, shown.htr] = [shown.r, t]
      else if (t - shown.htr > 1200) shown.hr = Math.max(MIN_DB, shown.hr - 0.6)

      const barH = 9
      const gap = 6
      const x0 = 18
      const bw = w - x0 - 4
      const pos = (db: number) => x0 + ((db - MIN_DB) / -MIN_DB) * bw
      const grad = ctx.createLinearGradient(x0, 0, x0 + bw, 0)
      grad.addColorStop(0, '#7c5cff')
      grad.addColorStop(0.62, '#18d6c4')
      grad.addColorStop(0.86, '#ffd166')
      grad.addColorStop(1, '#ff4757')
      ;[
        [shown.l, shown.rl, shown.hl, 'L'],
        [shown.r, shown.rr, shown.hr, 'R']
      ].forEach(([peak, rms, hold, label], i) => {
        const y = 4 + i * (barH + gap)
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(x0, y, bw, barH)
        ctx.globalAlpha = 0.45
        ctx.fillStyle = grad
        ctx.fillRect(x0, y, pos(peak as number) - x0, barH)
        ctx.globalAlpha = 1
        ctx.fillRect(x0, y, pos(rms as number) - x0, barH)
        if ((hold as number) > MIN_DB + 1) {
          ctx.fillStyle = (hold as number) > -1 ? '#ff4757' : '#e9e7ff'
          ctx.fillRect(pos(hold as number) - 1, y - 1, 2, barH + 2)
        }
        ctx.fillStyle = '#6f6c8f'
        ctx.font = '600 10px "Segoe UI Variable Text", "Segoe UI", sans-serif'
        ctx.fillText(label as string, 2, y + barH - 1)
      })
      ctx.fillStyle = '#5a577a'
      ctx.font = '10px "Segoe UI Variable Text", "Segoe UI", sans-serif'
      for (const db of [-48, -36, -24, -12, -6, 0]) {
        const x = pos(db)
        ctx.fillRect(x, 4 + 2 * barH + gap + 3, 1, 4)
        const s = String(db)
        ctx.fillText(s, Math.min(x - ctx.measureText(s).width / 2, w - ctx.measureText(s).width), 2 * barH + gap + 22)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [levels])
  return (
    <div className={`meter ${active ? '' : 'idle'}`}>
      <canvas ref={canvas} aria-label="Output level meter" role="img" />
    </div>
  )
}

/** Radial history of the stream's loudness around the share button. */
function Visualizer({ levels, active, muted }: { levels: React.RefObject<Levels>; active: boolean; muted: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active && !muted
  useEffect(() => {
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    const N = 72
    const hist = new Float32Array(N)
    let head = 0
    let last = 0
    let raf = 0
    let spin = 0
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1
      const size = c.clientWidth
      if (c.width !== size * dpr) {
        c.width = c.height = size * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      if (t - last > 45) {
        last = t
        const lv = levels.current
        const rms = Math.max(lv.rmsL, lv.rmsR)
        const v = activeRef.current ? Math.max(0, (toDb(rms) + 54) / 54) : 0
        hist[head] = v
        head = (head + 1) % N
      }
      spin += activeRef.current ? 0.0016 : 0.0006
      const cx = size / 2
      const r0 = size * 0.33
      const maxLen = size * 0.15
      for (let i = 0; i < N; i++) {
        const v = hist[(head + i) % N]
        const a = (i / N) * Math.PI * 2 + spin - Math.PI / 2
        const len = 3 + v * maxLen
        const x1 = cx + Math.cos(a) * r0
        const y1 = cx + Math.sin(a) * r0
        const x2 = cx + Math.cos(a) * (r0 + len)
        const y2 = cx + Math.sin(a) * (r0 + len)
        const hue = 255 - (i / N) * 85
        ctx.strokeStyle = `hsla(${hue}, 90%, ${62 + v * 10}%, ${0.25 + v * 0.75})`
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [levels])
  return <canvas ref={canvas} className="visualizer" aria-hidden />
}
