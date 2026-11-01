// Integration tests against the real syncwave-capture.exe and this PC's
// audio stack. One test plays a quiet 440 Hz tone (about -30 dBFS, ~3 s)
// through a helper PowerShell process and checks per-app capture hears it.
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FRAME_BYTES } from '@shared/protocol'
import { CaptureEngine, type CaptureSession } from '../../src/engine/capture'
import { Framer, measure } from '../../src/engine/processor'

const EXE = resolve(__dirname, '../../resources/bin/syncwave-capture.exe')
const engine = new CaptureEngine(EXE, -1)
let dir = ''
let wav = ''

function writeTone(file: string, seconds: number, amp: number): void {
  const rate = 48000
  const n = rate * seconds
  const data = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 2400, (n - i) / 2400)
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amp * fade * 32767)
    data.writeInt16LE(v, i * 4)
    data.writeInt16LE(v, i * 4 + 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([h, data]))
}

function playTone(): ChildProcess {
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`],
    { windowsHide: true, stdio: 'ignore' }
  )
}

/** Collects PCM from a session for `ms`, returning bytes and the loudest 20 ms frame. */
function collect(session: CaptureSession, ms: number): Promise<{ bytes: number; peak: number; ready: boolean }> {
  return new Promise((done) => {
    const framer = new Framer()
    let bytes = 0
    let peak = 0
    let ready = false
    session.on('ready', () => (ready = true))
    session.on('data', (c) => {
      bytes += c.length
      for (const f of framer.push(c)) peak = Math.max(peak, measure(f).peakL)
    })
    setTimeout(() => done({ bytes, peak, ready }), ms)
  })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'syncwave-native-'))
  wav = join(dir, 'tone.wav')
  writeTone(wav, 3, 0.03)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe.runIf(process.platform === 'win32')('syncwave-capture.exe', () => {
  it('exists (run npm run build:native first)', () => {
    expect(existsSync(EXE)).toBe(true)
  })

  it('lists sources as JSON', async () => {
    const list = await engine.listSources()
    expect(typeof list.processLoopbackSupported).toBe('boolean')
    expect(list.osBuild).toBeGreaterThan(10000)
    expect(Array.isArray(list.apps)).toBe(true)
  })

  it('streams system audio continuously at 48 kHz stereo s16 (silence is padded)', async () => {
    const s = engine.start({ mode: 'system' })
    const r = await collect(s, 1500)
    await s.stop()
    expect(r.ready).toBe(true)
    // 1.5 s ≈ 288 000 bytes; allow for start-up time.
    expect(r.bytes).toBeGreaterThan(192000)
    expect(r.bytes).toBeLessThan(330000)
    expect(r.bytes % 4).toBe(0)
  })

  it('captures one app (process loopback) and reports when it exits', async () => {
    const list = await engine.listSources()
    if (!list.processLoopbackSupported) return
    const player = playTone()
    try {
      const s = engine.start({ mode: 'process', pid: player.pid! })
      const ended = new Promise<number | null>((r) => s.once('exit', r))
      const r = await collect(s, 1800)
      expect(r.ready).toBe(true)
      expect(r.bytes).toBeGreaterThan(FRAME_BYTES * 50)
      // The tone is 0.03 full scale; capture must hear it, not just silence.
      expect(r.peak).toBeGreaterThan(0.01)
      expect(r.peak).toBeLessThan(0.1)
      // When the tone finishes PowerShell exits and the helper says so (exit 3).
      expect(await ended).toBe(3)
    } finally {
      player.kill()
    }
  })

  it('fails cleanly for a process that does not exist', async () => {
    const s = engine.start({ mode: 'process', pid: 4294967 })
    const errors: string[] = []
    s.on('error', (e) => errors.push(e))
    const code = await new Promise<number | null>((r) => s.once('exit', r))
    expect(code).toBe(2)
    expect(errors.join(' ')).toMatch(/not running/)
  })

  it('stops promptly when asked', async () => {
    const s = engine.start({ mode: 'system' })
    await new Promise((r) => s.once('ready', r))
    const t = Date.now()
    await s.stop()
    expect(s.running).toBe(false)
    expect(Date.now() - t).toBeLessThan(1000)
  })
})
