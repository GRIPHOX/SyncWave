// AudioProcessor: turns the helper's PCM byte stream into exact 20 ms frames,
// applies volume/mute with a click-free ramp, and measures levels.
import { FRAME_BYTES } from '@shared/protocol'
import type { Levels } from '@shared/types'

/** Re-chunks an arbitrary byte stream into fixed-size frames. */
export class Framer {
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly frameBytes = FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const frames: Buffer[] = []
    let offset = 0
    while (data.length - offset >= this.frameBytes) {
      // Copy so frames don't keep the large source chunk alive.
      frames.push(Buffer.from(data.subarray(offset, offset + this.frameBytes)))
      offset += this.frameBytes
    }
    this.pending = Buffer.from(data.subarray(offset))
    return frames
  }

  reset(): void {
    this.pending = Buffer.alloc(0)
  }
}

export function measure(frame: Buffer): Levels {
  let peakL = 0
  let peakR = 0
  let sumL = 0
  let sumR = 0
  const n = frame.length >> 2
  for (let i = 0; i < n; i++) {
    const l = frame.readInt16LE(i * 4) / 32768
    const r = frame.readInt16LE(i * 4 + 2) / 32768
    const al = Math.abs(l)
    const ar = Math.abs(r)
    if (al > peakL) peakL = al
    if (ar > peakR) peakR = ar
    sumL += l * l
    sumR += r * r
  }
  return { peakL, peakR, rmsL: n ? Math.sqrt(sumL / n) : 0, rmsR: n ? Math.sqrt(sumR / n) : 0 }
}

export class GainStage {
  private current = 1
  private target = 1

  /** volume in percent (0..200), muted overrides to 0. */
  set(volumePercent: number, muted: boolean): void {
    this.target = muted ? 0 : Math.max(0, Math.min(2, volumePercent / 100))
  }

  get gain(): number {
    return this.target
  }

  /** Applies gain in place, ramping linearly across the frame when it changes. */
  process(frame: Buffer): void {
    const n = frame.length >> 1
    const start = this.current
    const end = this.target
    if (start === 1 && end === 1) return
    if (start === 0 && end === 0) {
      frame.fill(0)
      return
    }
    const step = (end - start) / n
    let g = start
    for (let i = 0; i < n; i++) {
      let v = frame.readInt16LE(i * 2) * g
      if (v > 32767) v = 32767
      else if (v < -32768) v = -32768
      frame.writeInt16LE(Math.round(v), i * 2)
      g += step
    }
    this.current = end
  }
}

/** Combines levels of several frames: max of peaks, power-average of RMS. */
export class LevelAccumulator {
  private peakL = 0
  private peakR = 0
  private powL = 0
  private powR = 0
  private count = 0

  add(l: Levels): void {
    this.peakL = Math.max(this.peakL, l.peakL)
    this.peakR = Math.max(this.peakR, l.peakR)
    this.powL += l.rmsL * l.rmsL
    this.powR += l.rmsR * l.rmsR
    this.count++
  }

  take(): Levels | null {
    if (!this.count) return null
    const out = {
      peakL: this.peakL,
      peakR: this.peakR,
      rmsL: Math.sqrt(this.powL / this.count),
      rmsR: Math.sqrt(this.powR / this.count)
    }
    this.peakL = this.peakR = this.powL = this.powR = this.count = 0
    return out
  }
}
