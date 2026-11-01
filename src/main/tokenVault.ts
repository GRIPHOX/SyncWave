// TokenVault: the bot token, encrypted with Electron safeStorage (DPAPI on
// Windows, Keychain on macOS). Plaintext only ever lives in main-process
// memory and on the engine's private message port.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class TokenVault {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {}

  get secure(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  has(): boolean {
    return existsSync(this.file)
  }

  save(token: string): void {
    if (!this.secure) throw new Error('Secure storage is not available on this system, so the token was not saved.')
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, this.cipher.encryptString(token), { mode: 0o600 })
  }

  read(): string | null {
    if (!this.has() || !this.secure) return null
    try {
      return this.cipher.decryptString(readFileSync(this.file))
    } catch {
      return null // e.g. copied from another Windows account
    }
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
