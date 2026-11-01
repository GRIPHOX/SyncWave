// SettingsStore: JSON file in userData, validated on load and on every update.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/validate'
import type { Settings } from '@shared/types'

export class SettingsStore {
  private value: Settings

  constructor(private readonly file: string) {
    this.value = this.load()
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) return mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // Corrupt file: start from defaults; it is rewritten on the next save.
    }
    return structuredClone(DEFAULT_SETTINGS)
  }

  get(): Settings {
    return this.value
  }

  update(patch: unknown): Settings {
    this.value = mergeSettings(this.value, patch)
    this.save()
    return this.value
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // Write-then-rename so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2))
    renameSync(tmp, this.file)
  }
}
