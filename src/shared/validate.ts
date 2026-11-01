// Validation for anything that crosses a trust boundary: renderer → main IPC
// payloads and settings read from disk. Invalid input is rejected or replaced
// with defaults; nothing unvalidated reaches the engine.
import type { Settings, SourceSelection } from './types'

export class ValidationError extends Error {}

export const DEFAULT_SETTINGS: Settings = {
  audio: { volume: 100, muted: false, bitrateKbps: 128, maxLatencyMs: 120, excludeDiscordFromSystem: true },
  source: { defaultSource: { kind: 'system' }, rememberLast: true },
  discord: { autoConnectBot: true, autoJoinLast: false, lastGuildId: null, lastChannelId: null },
  startup: { launchAtLogin: false, startMinimized: false, closeToTray: true }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const SNOWFLAKE = /^\d{17,20}$/
const EXE = /^[^\\/:*?"<>|\r\n]{1,260}\.exe$/i

export function isSnowflake(v: unknown): v is string {
  return typeof v === 'string' && SNOWFLAKE.test(v)
}

export function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

export function requireSnowflake(v: unknown, name: string): string {
  if (!isSnowflake(v)) throw new ValidationError(`${name} must be a Discord ID`)
  return v
}

export function requireBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(`${name} must be a boolean`)
  return v
}

export function requireNumber(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new ValidationError(`${name} must be a number between ${min} and ${max}`)
  return v
}

/**
 * Discord bot tokens are three base64url segments separated by dots. This is a
 * shape check only — Discord decides whether the token is valid at login.
 */
export function validateBotToken(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('Token must be text')
  const token = v.trim().replace(/^Bot\s+/i, '')
  if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(token))
    throw new ValidationError("That doesn't look like a bot token. Copy it from Developer Portal → Bot → Reset Token.")
  return token
}

export function validateSourceSelection(v: unknown): SourceSelection {
  if (!isObj(v)) throw new ValidationError('Invalid source')
  if (v.kind === 'system') return { kind: 'system' }
  if (v.kind === 'app') {
    const pid = v.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)
      throw new ValidationError('Invalid process id')
    if (typeof v.exe !== 'string' || !EXE.test(v.exe)) throw new ValidationError('Invalid executable name')
    if (typeof v.name !== 'string' || v.name.length > 200) throw new ValidationError('Invalid source name')
    return { kind: 'app', pid, exe: v.exe, name: v.name }
  }
  throw new ValidationError('Invalid source kind')
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const snowOrNull = (v: unknown, fallback: string | null): string | null =>
  v === null ? null : isSnowflake(v) ? v : fallback

/**
 * Overlays `patch` onto `base`, keeping only known keys with valid values.
 * Used both for settings loaded from disk and for updates from the renderer.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const p = isObj(patch) ? patch : {}
  const a = isObj(p.audio) ? p.audio : {}
  const s = isObj(p.source) ? p.source : {}
  const d = isObj(p.discord) ? p.discord : {}
  const st = isObj(p.startup) ? p.startup : {}

  let defaultSource = base.source.defaultSource
  if (isObj(s.defaultSource)) {
    const ds = s.defaultSource
    if (ds.kind === 'system') defaultSource = { kind: 'system' }
    else if (ds.kind === 'app' && typeof ds.exe === 'string' && EXE.test(ds.exe) && typeof ds.name === 'string')
      defaultSource = { kind: 'app', exe: ds.exe, name: ds.name.slice(0, 200) }
  }

  return {
    audio: {
      volume: Math.round(clampNumber(a.volume, 0, 200, base.audio.volume)),
      muted: bool(a.muted, base.audio.muted),
      bitrateKbps: Math.round(clampNumber(a.bitrateKbps, 32, 256, base.audio.bitrateKbps)),
      maxLatencyMs: Math.round(clampNumber(a.maxLatencyMs, 40, 400, base.audio.maxLatencyMs)),
      excludeDiscordFromSystem: bool(a.excludeDiscordFromSystem, base.audio.excludeDiscordFromSystem)
    },
    source: { defaultSource, rememberLast: bool(s.rememberLast, base.source.rememberLast) },
    discord: {
      autoConnectBot: bool(d.autoConnectBot, base.discord.autoConnectBot),
      autoJoinLast: bool(d.autoJoinLast, base.discord.autoJoinLast),
      lastGuildId: snowOrNull(d.lastGuildId, base.discord.lastGuildId),
      lastChannelId: snowOrNull(d.lastChannelId, base.discord.lastChannelId)
    },
    startup: {
      launchAtLogin: bool(st.launchAtLogin, base.startup.launchAtLogin),
      startMinimized: bool(st.startMinimized, base.startup.startMinimized),
      closeToTray: bool(st.closeToTray, base.startup.closeToTray)
    }
  }
}

/** Only these hosts may be opened from the renderer. */
export function validateExternalUrl(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('Invalid URL')
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw new ValidationError('Invalid URL')
  }
  const allowed = ['discord.com', 'support.discord.com', 'github.com']
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname)) throw new ValidationError('URL not allowed')
  return url.toString()
}

/** Permissions: View Channel (1<<10) + Connect (1<<20) + Speak (1<<21). */
export const BOT_PERMISSIONS = (1n << 10n) | (1n << 20n) | (1n << 21n)

export function buildInviteUrl(clientId: string): string {
  requireSnowflake(clientId, 'clientId')
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${BOT_PERMISSIONS}&scope=bot`
}
