import { describe, expect, it } from 'vitest'
import { FRAME_BYTES, FRAME_SAMPLES } from '@shared/protocol'
import { createEncoder } from '../../src/engine/opus'
import { Framer, GainStage, LevelAccumulator, measure } from '../../src/engine/processor'
import { OpusPacketStream } from '../../src/engine/pump'

function sine(freq: number, amp: number, frames = FRAME_SAMPLES): Buffer {
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * amp * 32767)
    b.writeInt16LE(v, i * 4)
    b.writeInt16LE(v, i * 4 + 2)
  }
  return b
}

describe('Framer', () => {
  it('re-chunks arbitrary chunk sizes into exact 20 ms frames', () => {
    const f = new Framer()
    const total = FRAME_BYTES * 5 + 100
    const data = Buffer.alloc(total, 7)
    const frames: Buffer[] = []
    for (let off = 0; off < total; off += 1234) frames.push(...f.push(data.subarray(off, off + 1234)))
    expect(frames).toHaveLength(5)
    expect(frames.every((fr) => fr.length === FRAME_BYTES)).toBe(true)
    expect(f.push(Buffer.alloc(FRAME_BYTES - 100))).toHaveLength(1)
  })
})

describe('GainStage', () => {
  it('is a no-op at unity gain', () => {
    const g = new GainStage()
    const f = sine(1000, 0.5)
    const copy = Buffer.from(f)
    g.process(f)
    expect(f.equals(copy)).toBe(true)
  })
  it('ramps to silence when muted, then stays silent', () => {
    const g = new GainStage()
    g.set(100, true)
    const first = sine(1000, 0.5)
    g.process(first)
    // Ramp: start of frame still has signal, end is (near) silent.
    expect(measure(first.subarray(0, 400)).peakL).toBeGreaterThan(0.05)
    expect(measure(first.subarray(first.length - 40)).peakL).toBeLessThan(0.02)
    const second = sine(1000, 0.5)
    g.process(second)
    expect(measure(second).peakL).toBe(0)
  })
  it('boosts up to 200% and hard-limits instead of wrapping', () => {
    const g = new GainStage()
    g.set(200, false)
    g.process(sine(1000, 0.9)) // ramp frame
    const f = sine(1000, 0.9)
    g.process(f)
    const l = measure(f)
    expect(l.peakL).toBeGreaterThan(0.99)
    expect(l.peakL).toBeLessThanOrEqual(1)
  })
})

describe('levels', () => {
  it('measures peak and RMS of a sine', () => {
    const l = measure(sine(1000, 0.5))
    expect(l.peakL).toBeCloseTo(0.5, 2)
    expect(l.rmsL).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
  it('accumulates max peak and power-averaged RMS, then resets', () => {
    const acc = new LevelAccumulator()
    acc.add({ peakL: 0.2, peakR: 0.1, rmsL: 0.1, rmsR: 0.1 })
    acc.add({ peakL: 0.6, peakR: 0.1, rmsL: 0.3, rmsR: 0.1 })
    const out = acc.take()!
    expect(out.peakL).toBe(0.6)
    expect(out.rmsL).toBeCloseTo(Math.sqrt((0.01 + 0.09) / 2), 6)
    expect(acc.take()).toBeNull()
  })
})

describe('OpusPacketStream', () => {
  const pkt = (n: number) => Buffer.from([n])

  it('hands packets to a reader in order', async () => {
    const s = new OpusPacketStream(10)
    s.pushPacket(pkt(1))
    s.pushPacket(pkt(2))
    expect(s.read()?.[0]).toBe(1)
    expect(s.read()?.[0]).toBe(2)
  })

  it('caps the queue by dropping the oldest packets', () => {
    const s = new OpusPacketStream(3)
    for (let i = 0; i < 10; i++) s.pushPacket(pkt(i))
    expect(s.stats.droppedFrames).toBeGreaterThanOrEqual(6)
    const got: number[] = []
    let p: Buffer | null
    while ((p = s.read())) got.push(p[0])
    expect(got[got.length - 1]).toBe(9) // newest audio is never dropped
    expect(got.length).toBeLessThanOrEqual(4)
  })

  it('trims a standing backlog back to the target within ~2 s', () => {
    let now = 0
    const s = new OpusPacketStream(20, 2, () => now)
    for (let i = 0; i < 12; i++) s.pushPacket(pkt(i)) // backlog of ~12
    // Steady state: one in, one out, every 20 ms for two measurement windows.
    for (let t = 0; t < 110; t++) {
      now += 20
      s.read()
      s.pushPacket(pkt(100 + t))
    }
    expect(s.stats.queuedFrames).toBeLessThanOrEqual(3)
    expect(s.stats.droppedFrames).toBeGreaterThan(0)
  })
})

describe('Opus encoder', () => {
  for (const prefer of ['auto', 'opusscript'] as const) {
    it(`encodes real audio that decodes back to a similar signal (${prefer})`, async () => {
      const enc = createEncoder(128, prefer)
      if (prefer === 'opusscript') expect(enc.kind).toBe('opusscript')
      const packets = Array.from({ length: 10 }, () => enc.encode(sine(1000, 0.5)))
      expect(packets.every((p) => p.length > 10 && p.length < 1275)).toBe(true)
      // Decode with libopus to prove the packets are valid Opus.
      const { OpusEncoder } = await import('@discordjs/opus')
      const dec = new OpusEncoder(48000, 2)
      let pcm: Buffer = Buffer.alloc(0)
      for (const p of packets) pcm = dec.decode(p) // decoders need context; check the last frame
      expect(pcm.length).toBe(FRAME_BYTES)
      expect(measure(pcm).rmsL).toBeGreaterThan(0.25)
      enc.destroy()
    })
  }
  it('encodes silence into tiny packets', () => {
    const enc = createEncoder(128)
    const p = enc.encode(Buffer.alloc(FRAME_BYTES))
    expect(p.length).toBeLessThan(20)
  })
})
