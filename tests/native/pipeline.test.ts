// Real pipeline minus the network: capture helper → StreamController (framing,
// gain, Opus) → OpusPacketStream → the real @discordjs/voice AudioPlayer.
// Plays a quiet tone in a helper process, captures that process, and checks
// that the player consumes Opus packets in real time and that they decode to
// the tone. Only the UDP hop to Discord is missing (needs a bot token).
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { AudioPlayerStatus } from '@discordjs/voice'
import { OpusEncoder } from '@discordjs/opus'
import { describe, expect, it } from 'vitest'
import { CaptureEngine } from '../../src/engine/capture'
import { measure } from '../../src/engine/processor'
import type { OpusPacketStream } from '../../src/engine/pump'
import { StreamController } from '../../src/engine/stream'
import { VoiceStreamer } from '../../src/engine/voice'

const EXE = resolve(__dirname, '../../resources/bin/syncwave-capture.exe')

function toneWav(file: string): void {
  const rate = 48000
  const n = rate * 3
  const data = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.03 * Math.min(1, i / 2400, (n - i) / 2400) * 32767)
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

describe.runIf(process.platform === 'win32')('capture → Opus → voice player', () => {
  it('streams a captured app through the real AudioPlayer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncwave-pipe-'))
    const wav = join(dir, 'tone.wav')
    toneWav(wav)
    const player = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], {
      windowsHide: true,
      stdio: 'ignore'
    })

    const voice = new VoiceStreamer()
    const decoder = new OpusEncoder(48000, 2)
    let loudest = 0
    let packets = 0
    let pump: OpusPacketStream | null = null
    // Tap the stream the player reads, decoding what Discord would receive.
    const sink = {
      play: (s: OpusPacketStream) => {
        pump = s
        const read = s.read.bind(s)
        s.read = ((size?: number) => {
          const p = read(size)
          if (p) {
            packets++
            loudest = Math.max(loudest, measure(decoder.decode(p)).peakL)
          }
          return p
        }) as typeof s.read
        voice.play(s)
      },
      stopPlayback: () => voice.stopPlayback()
    }
    const ctl = new StreamController(new CaptureEngine(EXE, -1), sink)
    ctl.setConfig({ volume: 100, muted: false, bitrateKbps: 128, maxLatencyMs: 120 })
    const states: string[] = []
    ctl.on('state', (s) => states.push(s.status))

    try {
      await new Promise((r) => setTimeout(r, 300))
      await ctl.start({ kind: 'app', pid: player.pid!, exe: 'powershell.exe', name: 'PowerShell' }, false)
      await new Promise((r) => setTimeout(r, 2000))

      expect(states).toContain('live')
      expect(voice.player.state.status).toBe(AudioPlayerStatus.Playing)
      // ~2 s at 50 packets/s, consumed by the player's own 20 ms clock.
      expect(packets).toBeGreaterThan(70)
      expect(packets).toBeLessThan(110)
      // The decoded Opus contains the tone (0.03 full scale).
      expect(loudest).toBeGreaterThan(0.01)
      expect(loudest).toBeLessThan(0.1)
      // Latency stays bounded by the queue.
      expect(pump!.stats.queuedFrames).toBeLessThanOrEqual(6)

      // When the app exits, sharing stops with a notice.
      await new Promise((r) => player.once('exit', r))
      await new Promise((r) => setTimeout(r, 500))
      expect(ctl.current.status).toBe('idle')
      expect(ctl.current.notice).toMatch(/PowerShell closed/)
    } finally {
      player.kill()
      await ctl.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
