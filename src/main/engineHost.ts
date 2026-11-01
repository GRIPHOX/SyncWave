// EngineHost: starts the engine utilityProcess, routes requests/replies, and
// restarts it with backoff if it crashes.
import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'events'
import type { EngineMessage, EngineRequest, EngineRequestEnvelope } from '@shared/protocol'
import type { EngineLifecycle, EngineState, Levels } from '@shared/types'

interface HostEvents {
  lifecycle: [EngineLifecycle, string | undefined]
  state: [EngineState]
  levels: [Levels]
  log: ['info' | 'warn' | 'error', string]
  /** Fired after every (re)start once the engine is ready for requests. */
  ready: []
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 30_000

export class EngineHost extends EventEmitter<HostEvents> {
  private child: UtilityProcess | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private crashes: number[] = []
  private stopping = false
  lifecycle: EngineLifecycle = 'starting'
  lastError: string | undefined

  constructor(
    private readonly modulePath: string,
    private readonly args: string[]
  ) {
    super()
  }

  start(): void {
    this.stopping = false
    this.setLifecycle(this.crashes.length ? 'restarting' : 'starting')
    const child = utilityProcess.fork(this.modulePath, this.args, { serviceName: 'SyncWave Engine', stdio: 'pipe' })
    this.child = child
    child.stdout?.on('data', (d) => this.emit('log', 'info', `[engine] ${String(d).trim()}`))
    child.stderr?.on('data', (d) => this.emit('log', 'error', `[engine] ${String(d).trim()}`))
    child.on('message', (msg: EngineMessage) => this.onMessage(msg))
    child.on('exit', (code) => this.onExit(child, code))
  }

  private setLifecycle(l: EngineLifecycle, error?: string): void {
    this.lifecycle = l
    this.lastError = error
    this.emit('lifecycle', l, error)
  }

  private onMessage(msg: EngineMessage): void {
    switch (msg.type) {
      case 'ready':
        this.setLifecycle('running')
        this.emit('ready')
        break
      case 'state':
        this.emit('state', msg.state)
        break
      case 'levels':
        this.emit('levels', msg.levels)
        break
      case 'log':
        this.emit('log', msg.level, msg.message)
        break
      case 'reply': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error))
        break
      }
    }
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return
    this.child = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('The audio engine stopped.'))
    }
    this.pending.clear()
    if (this.stopping) return

    const now = Date.now()
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now]
    this.emit('log', 'error', `Engine exited with code ${code}`)
    if (this.crashes.length > 4) {
      this.setLifecycle('failed', 'The audio engine keeps crashing. Restart SyncWave; if it persists, check the log.')
      return
    }
    this.setLifecycle('restarting', `Engine exited (code ${code}); restarting…`)
    setTimeout(() => this.start(), 500 * this.crashes.length)
  }

  request<T = unknown>(request: EngineRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const child = this.child
    if (!child || this.lifecycle !== 'running') return Promise.reject(new Error('The audio engine is not running.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The audio engine did not respond in time.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.postMessage({ id, request } satisfies EngineRequestEnvelope)
    })
  }

  /** Graceful shutdown: leave voice, log out, then kill if it lingers. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    await Promise.race([
      this.request({ type: 'shutdown' }, 4000).catch(() => {}),
      new Promise((r) => setTimeout(r, 4000))
    ])
    if (this.child === child) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill()
          resolve()
        }, 1000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    this.child = null
  }
}
