// OpusPacketStream: the hand-off between our encoder and @discordjs/voice.
//
// The capture clock (sound card) and Discord's player clock (a 20 ms timer)
// drift apart. A plain stream would buffer the difference forever and latency
// would creep up. This queue has a hard cap (drop oldest) and a soft target:
// if the queue never fell below `targetFrames` during a whole second, the
// surplus is trimmed. That keeps latency near the target.
import { Readable } from 'stream'

export interface PumpStats {
  queuedFrames: number
  droppedFrames: number
}

export class OpusPacketStream extends Readable {
  private queue: Buffer[] = []
  private wanting = false
  private dropped = 0
  private windowMin = Infinity
  private windowStart = 0

  constructor(
    private maxFrames: number,
    private readonly targetFrames = 2,
    private readonly now: () => number = Date.now
  ) {
    super({ objectMode: true, highWaterMark: 1 })
    this.windowStart = now()
  }

  setMaxFrames(n: number): void {
    this.maxFrames = Math.max(this.targetFrames + 1, Math.floor(n))
    this.trimTo(this.maxFrames)
  }

  pushPacket(packet: Buffer): void {
    if (this.destroyed) return
    this.queue.push(packet)
    this.trimTo(this.maxFrames)
    this.drain()
    this.windowMin = Math.min(this.windowMin, this.queue.length)
    const t = this.now()
    if (t - this.windowStart >= 1000) {
      if (this.windowMin !== Infinity && this.windowMin > this.targetFrames) {
        this.dropOldest(this.windowMin - this.targetFrames)
      }
      this.windowMin = Infinity
      this.windowStart = t
    }
  }

  get stats(): PumpStats {
    return { queuedFrames: this.queue.length + this.readableLength, droppedFrames: this.dropped }
  }

  override _read(): void {
    this.wanting = true
    this.drain()
  }

  private drain(): void {
    while (this.wanting && this.queue.length) {
      this.wanting = this.push(this.queue.shift())
    }
  }

  private trimTo(max: number): void {
    if (this.queue.length > max) this.dropOldest(this.queue.length - max)
  }

  private dropOldest(n: number): void {
    this.queue.splice(0, n)
    this.dropped += n
  }
}
