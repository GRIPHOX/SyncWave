import type { SyncWaveApi } from '@shared/api'

declare global {
  interface Window {
    syncwave: SyncWaveApi
  }
}

export {}
