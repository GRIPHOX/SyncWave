// Small hooks around window.syncwave: live snapshot, levels and toasts.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot, Levels } from '@shared/types'

export const api = window.syncwave

/** Electron prefixes IPC errors with "Error invoking remote method 'x': Error: ". */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useSnapshot(): AppSnapshot | null {
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void api.getSnapshot().then((s) => alive && setSnap(s))
    const off = api.onSnapshot(setSnap)
    return () => {
      alive = false
      off()
    }
  }, [])
  return snap
}

/** Latest levels in a ref, so the meters can animate without re-rendering React. */
export function useLevelsRef(): React.RefObject<Levels> {
  const ref = useRef<Levels>({ peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 })
  useEffect(() => api.onLevels((l) => (ref.current = l)), [])
  return ref
}

export interface Toast {
  id: number
  kind: 'error' | 'info'
  text: string
}

export function useToasts(): {
  toasts: Toast[]
  push: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = next.current++
      setToasts((t) => [...t.slice(-3), { id, kind, text }])
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500)
    },
    [dismiss]
  )
  return { toasts, push, dismiss }
}

/** Runs an API call, routing failures to a toast. Returns a busy flag per call site. */
export function useAction(onError: (msg: string) => void) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await fn()
        return true
      } catch (e) {
        onError(cleanError(e))
        return false
      } finally {
        setBusy(false)
      }
    },
    [onError]
  )
  return { busy, run }
}

export function toDb(v: number): number {
  return v <= 0.000001 ? -90 : 20 * Math.log10(v)
}
