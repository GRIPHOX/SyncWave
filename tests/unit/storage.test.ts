import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/validate'
import { SettingsStore } from '../../src/main/settings'
import { TokenVault, type Cipher } from '../../src/main/tokenVault'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'syncwave-test-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

// Stand-in for safeStorage: reversible, and visibly not plaintext.
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString()
})

describe('SettingsStore', () => {
  it('persists updates and reloads them', () => {
    const file = join(tmp(), 'settings.json')
    new SettingsStore(file).update({ audio: { volume: 42 }, startup: { closeToTray: false } })
    const again = new SettingsStore(file).get()
    expect(again.audio.volume).toBe(42)
    expect(again.startup.closeToTray).toBe(false)
  })
  it('survives a corrupt file', () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, '{not json')
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('TokenVault', () => {
  it('never writes the token in plaintext and reads it back', () => {
    const file = join(tmp(), 'token.bin')
    const v = new TokenVault(file, fakeCipher())
    v.save('secret-token-value')
    expect(readFileSync(file).toString()).not.toContain('secret-token-value')
    expect(v.read()).toBe('secret-token-value')
    v.clear()
    expect(v.has()).toBe(false)
    expect(v.read()).toBeNull()
  })
  it('refuses to save when secure storage is unavailable', () => {
    const v = new TokenVault(join(tmp(), 'token.bin'), fakeCipher(false))
    expect(() => v.save('x')).toThrow(/Secure storage/)
    expect(v.has()).toBe(false)
  })
})
