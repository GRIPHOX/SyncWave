import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  ValidationError,
  buildInviteUrl,
  mergeSettings,
  requireSnowflake,
  validateBotToken,
  validateExternalUrl,
  validateSourceSelection
} from '@shared/validate'

// Shape-valid fake token (not a real credential).
const FAKE_TOKEN = ['MTAwMDAwMDAwMDAwMDAwMDAw', 'GabCdE', 'a'.repeat(38)].join('.')

describe('validateBotToken', () => {
  it('accepts a well-formed token and strips whitespace / "Bot " prefix', () => {
    expect(validateBotToken(`  ${FAKE_TOKEN}\n`)).toBe(FAKE_TOKEN)
    expect(validateBotToken(`Bot ${FAKE_TOKEN}`)).toBe(FAKE_TOKEN)
  })
  it('rejects junk, non-strings and things that look like other secrets', () => {
    for (const bad of ['', 'hello', 123, null, 'a.b.c', 'mfa.' + 'x'.repeat(80), FAKE_TOKEN + ' extra'])
      expect(() => validateBotToken(bad)).toThrow(ValidationError)
  })
})

describe('validateSourceSelection', () => {
  it('accepts system and app selections', () => {
    expect(validateSourceSelection({ kind: 'system', extra: 1 })).toEqual({ kind: 'system' })
    expect(validateSourceSelection({ kind: 'app', pid: 42, exe: 'chrome.exe', name: 'Chrome' })).toEqual({
      kind: 'app',
      pid: 42,
      exe: 'chrome.exe',
      name: 'Chrome'
    })
  })
  it('rejects bad pids, paths and kinds', () => {
    const bad = [
      { kind: 'app', pid: -1, exe: 'a.exe', name: 'a' },
      { kind: 'app', pid: 1.5, exe: 'a.exe', name: 'a' },
      { kind: 'app', pid: 4, exe: 'C:\\evil\\a.exe', name: 'a' },
      { kind: 'app', pid: 4, exe: 'a.bat', name: 'a' },
      { kind: 'mic' },
      'system',
      null
    ]
    for (const b of bad) expect(() => validateSourceSelection(b)).toThrow(ValidationError)
  })
})

describe('mergeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, 'nope')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(DEFAULT_SETTINGS, { audio: 5, unknown: true })).toEqual(DEFAULT_SETTINGS)
  })
  it('clamps numbers and ignores wrong types', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, {
      audio: { volume: 999, bitrateKbps: 1, maxLatencyMs: 'x', muted: 'yes' },
      startup: { launchAtLogin: true }
    })
    expect(s.audio.volume).toBe(200)
    expect(s.audio.bitrateKbps).toBe(32)
    expect(s.audio.maxLatencyMs).toBe(DEFAULT_SETTINGS.audio.maxLatencyMs)
    expect(s.audio.muted).toBe(false)
    expect(s.startup.launchAtLogin).toBe(true)
  })
  it('only keeps snowflake channel ids and valid default sources', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, {
      discord: { lastGuildId: '123456789012345678', lastChannelId: 'drop table' },
      source: { defaultSource: { kind: 'app', exe: 'spotify.exe', name: 'Spotify' } }
    })
    expect(s.discord.lastGuildId).toBe('123456789012345678')
    expect(s.discord.lastChannelId).toBeNull()
    expect(s.source.defaultSource).toEqual({ kind: 'app', exe: 'spotify.exe', name: 'Spotify' })
    expect(mergeSettings(s, { source: { defaultSource: { kind: 'app', exe: '../x' } } }).source.defaultSource).toEqual(
      s.source.defaultSource
    )
  })
  it('does not mutate the base', () => {
    const base = structuredClone(DEFAULT_SETTINGS)
    mergeSettings(base, { audio: { volume: 10 } })
    expect(base).toEqual(DEFAULT_SETTINGS)
  })
})

describe('external URLs and invites', () => {
  it('allows only https Discord/GitHub URLs', () => {
    expect(validateExternalUrl('https://discord.com/developers/applications')).toContain('discord.com')
    for (const bad of ['http://discord.com', 'https://evil.com', 'file:///C:/x', 'javascript:alert(1)', 'https://discord.com.evil.io'])
      expect(() => validateExternalUrl(bad)).toThrow()
  })
  it('builds a minimal-permission invite URL', () => {
    const url = new URL(buildInviteUrl('123456789012345678'))
    expect(url.searchParams.get('scope')).toBe('bot')
    expect(url.searchParams.get('permissions')).toBe(String((1 << 10) + (1 << 20) + (1 << 21)))
    expect(() => buildInviteUrl('abc')).toThrow()
    expect(() => requireSnowflake('12', 'x')).toThrow()
  })
})
