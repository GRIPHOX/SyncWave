// CaptureEngine: owns the native syncwave-capture.exe helper.
// stdout = raw PCM (s16le/48k/stereo), stderr = JSON lines, stdin = commands.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import type { AppSource, CaptureTarget, SourceList } from '@shared/types'

export type HelperEvent =
  | { event: 'ready'; mode: string; device: string; rate: number; channels: number; format: string }
  | { event: 'error'; code: string; hr: string; message: string }
  | { event: 'source-ended'; pid: number }
  | { event: 'device-changed' }
  | { event: 'stopped'; code: number }

/** Splits a byte stream into complete lines and parses each as a helper event. */
export class EventLineParser {
  private buffer = ''

  push(chunk: string): HelperEvent[] {
    this.buffer += chunk
    const out: HelperEvent[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.event === 'string') out.push(parsed as HelperEvent)
      } catch {
        // Not JSON (e.g. a crash message) — surface it as an error event.
        out.push({ event: 'error', code: 'helper_output', hr: '0x0', message: line.slice(0, 300) })
      }
    }
    if (this.buffer.length > 64 * 1024) this.buffer = ''
    return out
  }
}

export function targetArgs(target: CaptureTarget): string[] {
  switch (target.mode) {
    case 'system':
      return ['capture', '--system']
    case 'system-exclude':
      return ['capture', '--system', '--exclude-pid', String(target.pid)]
    case 'process':
      return ['capture', '--pid', String(target.pid)]
  }
}

export function parseSourceList(json: string, hostPid: number): SourceList {
  const raw = JSON.parse(json)
  const apps: AppSource[] = Array.isArray(raw.sources)
    ? raw.sources
        .filter((s: AppSource) => typeof s.pid === 'number' && s.pid !== hostPid && s.pid !== process.pid)
        .map((s: AppSource) => ({
          pid: s.pid,
          name: String(s.name ?? s.exe ?? ''),
          exe: String(s.exe ?? ''),
          path: String(s.path ?? ''),
          title: String(s.title ?? ''),
          hasAudioSession: !!s.hasAudioSession,
          active: !!s.active,
          peak: Number(s.peak) || 0
        }))
    : []
  // Playing first, then apps with an audio session, then the rest; by name.
  const rank = (s: AppSource): number => (s.active && s.peak > 0.001 ? 0 : s.hasAudioSession ? 1 : 2)
  apps.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return {
    processLoopbackSupported: !!raw.processLoopbackSupported,
    osBuild: Number(raw.osBuild) || 0,
    defaultDevice: String(raw.defaultDevice ?? ''),
    apps
  }
}

export interface CaptureSessionEvents {
  data: [Buffer]
  ready: [Extract<HelperEvent, { event: 'ready' }>]
  'source-ended': []
  'device-changed': []
  error: [string]
  exit: [number | null]
}

/** One running capture helper. Emits PCM chunks until stopped or the source dies. */
export class CaptureSession extends EventEmitter<CaptureSessionEvents> {
  private child: ChildProcessWithoutNullStreams
  private parser = new EventLineParser()
  private exited = false
  private killTimer: NodeJS.Timeout | null = null

  constructor(exe: string, readonly target: CaptureTarget) {
    super()
    this.child = spawn(exe, targetArgs(target), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk: Buffer) => this.emit('data', chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (text: string) => {
      for (const ev of this.parser.push(text)) this.handle(ev)
    })
    this.child.on('error', (err) => this.emit('error', `Could not start the capture helper: ${err.message}`))
    this.child.on('exit', (code) => {
      this.exited = true
      if (this.killTimer) clearTimeout(this.killTimer)
      this.emit('exit', code)
    })
    // stdin errors (EPIPE after the helper exits) are expected; ignore them.
    this.child.stdin.on('error', () => {})
  }

  private handle(ev: HelperEvent): void {
    if (ev.event === 'ready') this.emit('ready', ev)
    else if (ev.event === 'source-ended') this.emit('source-ended')
    else if (ev.event === 'device-changed') this.emit('device-changed')
    else if (ev.event === 'error') this.emit('error', ev.message + (ev.hr && ev.hr !== '0x0' ? ` (${ev.hr})` : ''))
  }

  get running(): boolean {
    return !this.exited
  }

  /** Asks the helper to stop; kills it if it doesn't exit within 2 s. */
  stop(): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise((resolve) => {
      this.once('exit', () => resolve())
      this.child.stdin.write('stop\n')
      this.child.stdin.end()
      this.killTimer = setTimeout(() => this.child.kill(), 2000)
    })
  }

  kill(): void {
    if (!this.exited) this.child.kill()
  }
}

export class CaptureEngine {
  constructor(
    private readonly exe: string,
    private readonly hostPid: number
  ) {}

  listSources(): Promise<SourceList> {
    return new Promise((resolve, reject) => {
      execFile(this.exe, ['list'], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`Could not list audio sources: ${err.message}`))
        try {
          resolve(parseSourceList(stdout, this.hostPid))
        } catch (e) {
          reject(new Error(`Capture helper returned invalid data: ${(e as Error).message}`))
        }
      })
    })
  }

  start(target: CaptureTarget): CaptureSession {
    return new CaptureSession(this.exe, target)
  }
}
