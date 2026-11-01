import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { FRAME_BYTES } from '@shared/protocol'
import type { CaptureTarget, SourceList } from '@shared/types'
import { EventLineParser, parseSourceList, targetArgs } from '../../src/engine/capture'
import type { OpusPacketStream } from '../../src/engine/pump'
import { StreamController, resolveTarget } from '../../src/engine/stream'

const list = (apps: Partial<SourceList['apps'][number]>[], supported = true): SourceList => ({
  processLoopbackSupported: supported,
  osBuild: 19045,
  defaultDevice: 'Speakers',
  apps: apps.map((a, i) => ({
    pid: 100 + i,
    name: 'x',
    exe: 'x.exe',
    path: '',
    title: '',
    hasAudioSession: true,
    active: false,
    peak: 0,
    ...a
  }))
})

describe('capture helper protocol', () => {
  it('parses JSON events split across chunks', () => {
    const p = new EventLineParser()
    expect(p.push('{"event":"rea')).toEqual([])
    const evs = p.push('dy","device":"Spk"}\n{"event":"source-ended","pid":5}\n')
    expect(evs.map((e) => e.event)).toEqual(['ready', 'source-ended'])
  })
  it('turns non-JSON output into an error event', () => {
    const [ev] = new EventLineParser().push('boom\n')
    expect(ev.event).toBe('error')
  })
  it('builds helper arguments per mode', () => {
    expect(targetArgs({ mode: 'system' })).toEqual(['capture', '--system'])
    expect(targetArgs({ mode: 'process', pid: 7 })).toEqual(['capture', '--pid', '7'])
    expect(targetArgs({ mode: 'system-exclude', pid: 9 })).toEqual(['capture', '--system', '--exclude-pid', '9'])
  })
  it('filters the host app and sorts playing apps first', () => {
    const json = JSON.stringify({
      processLoopbackSupported: true,
      osBuild: 19045,
      defaultDevice: 'Spk',
      sources: [
        { pid: 1, name: 'Zed', exe: 'z.exe', hasAudioSession: false },
        { pid: 2, name: 'Host', exe: 'SyncWave.exe', hasAudioSession: true },
        { pid: 3, name: 'Beta', exe: 'b.exe', hasAudioSession: true },
        { pid: 4, name: 'Alpha', exe: 'a.exe', hasAudioSession: true, active: true, peak: 0.3 }
      ]
    })
    const parsed = parseSourceList(json, 2)
    expect(parsed.apps.map((a) => a.pid)).toEqual([4, 3, 1])
  })
})

describe('resolveTarget', () => {
  it('captures an app by pid', () => {
    expect(resolveTarget({ kind: 'app', pid: 55, exe: 'a.exe', name: 'A' }, true, null)).toEqual({ mode: 'process', pid: 55 })
  })
  it('excludes Discord from system audio when it is running', () => {
    const sources = list([{ exe: 'Spotify.exe' }, { exe: 'Discord.exe', pid: 777 }])
    expect(resolveTarget({ kind: 'system' }, true, sources)).toEqual({ mode: 'system-exclude', pid: 777 })
    expect(resolveTarget({ kind: 'system' }, false, sources)).toEqual({ mode: 'system' })
  })
  it('falls back to plain system capture without Discord or on old Windows', () => {
    expect(resolveTarget({ kind: 'system' }, true, list([{ exe: 'Spotify.exe' }]))).toEqual({ mode: 'system' })
    expect(resolveTarget({ kind: 'system' }, true, list([{ exe: 'Discord.exe' }], false))).toEqual({ mode: 'system' })
  })
})

// ---- StreamController with a fake helper and a fake Discord player ----

class FakeSession extends EventEmitter {
  stopped = false
  constructor(readonly target: CaptureTarget) {
    super()
  }
  stop() {
    this.stopped = true
    setImmediate(() => this.emit('exit', 0))
    return Promise.resolve()
  }
  kill() {}
}

function rig() {
  const sessions: FakeSession[] = []
  const capture = {
    listSources: vi.fn(async () => list([{ exe: 'Discord.exe', pid: 900 }])),
    start: vi.fn((t: CaptureTarget) => {
      const s = new FakeSession(t)
      sessions.push(s)
      return s
    })
  }
  const played: OpusPacketStream[] = []
  const sink = { play: vi.fn((s: OpusPacketStream) => played.push(s)), stopPlayback: vi.fn() }
  const ctl = new StreamController(capture as never, sink)
  return { ctl, capture, sink, sessions, played }
}

describe('StreamController', () => {
  it('goes starting → live and turns PCM into Opus packets', async () => {
    const { ctl, sessions, played } = rig()
    await ctl.start({ kind: 'system' }, true)
    expect(sessions[0].target).toEqual({ mode: 'system-exclude', pid: 900 })
    expect(ctl.current.status).toBe('starting')
    sessions[0].emit('ready', { event: 'ready', device: 'Spk' })
    expect(ctl.current.status).toBe('live')
    expect(ctl.current.sourceLabel).toBe('System audio (without Discord)')
    sessions[0].emit('data', Buffer.alloc(FRAME_BYTES * 3 + 10))
    expect(played[0].stats.queuedFrames).toBe(3)
    await ctl.stop()
  })

  it('switches source without recreating the player', async () => {
    const { ctl, sessions, sink } = rig()
    await ctl.start({ kind: 'system' }, false)
    sessions[0].emit('ready', { event: 'ready', device: 'Spk' })
    await ctl.start({ kind: 'app', pid: 42, exe: 'vlc.exe', name: 'VLC' }, false)
    expect(sessions[0].stopped).toBe(true)
    expect(sessions[1].target).toEqual({ mode: 'process', pid: 42 })
    expect(sink.play).toHaveBeenCalledTimes(1)
    expect(sink.stopPlayback).not.toHaveBeenCalled()
    await ctl.stop()
  })

  it('stops with a notice when the app closes', async () => {
    const { ctl, sessions, sink } = rig()
    await ctl.start({ kind: 'app', pid: 42, exe: 'vlc.exe', name: 'VLC' }, false)
    sessions[0].emit('ready', { event: 'ready', device: 'loop' })
    sessions[0].emit('source-ended')
    await vi.waitFor(() => expect(ctl.current.status).toBe('idle'))
    expect(ctl.current.notice).toMatch(/VLC closed/)
    expect(sink.stopPlayback).toHaveBeenCalled()
  })

  it('reports an error if the helper dies', async () => {
    const { ctl, sessions } = rig()
    await ctl.start({ kind: 'system' }, false)
    sessions[0].emit('error', 'Could not open the audio stream. (0x88890004)')
    sessions[0].emit('exit', 2)
    await vi.waitFor(() => expect(ctl.current.status).toBe('error'))
    expect(ctl.current.error).toContain('0x88890004')
  })

  it('applies mute to what gets encoded', async () => {
    const { ctl, sessions } = rig()
    const levels: number[] = []
    ctl.on('levels', (l) => levels.push(l.peakL))
    ctl.setConfig({ volume: 100, muted: true, bitrateKbps: 96, maxLatencyMs: 120 })
    await ctl.start({ kind: 'system' }, false)
    sessions[0].emit('ready', { event: 'ready', device: 'Spk' })
    const loud = Buffer.alloc(FRAME_BYTES * 4)
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(20000, i)
    sessions[0].emit('data', loud) // first frame ramps down
    await new Promise((r) => setTimeout(r, 80))
    sessions[0].emit('data', Buffer.from(loud))
    await new Promise((r) => setTimeout(r, 80))
    expect(levels.length).toBeGreaterThan(0)
    expect(levels[levels.length - 1]).toBe(0)
    await ctl.stop()
  })
})
