// IPC router. Every handler checks the sender and validates its payload
// before anything reaches the controller or the engine.
import { app, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC } from '@shared/api'
import {
  ValidationError,
  requireBoolean,
  requireNumber,
  requireSnowflake,
  validateExternalUrl,
  validateSourceSelection
} from '@shared/validate'
import type { AppController } from './controller'

const iconCache = new Map<string, string | null>()

export function registerIpc(controller: AppController, isTrusted: (wc: WebContents) => boolean): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrusted(event.sender)) throw new Error('Untrusted sender')
      try {
        return await fn(...args)
      } catch (err) {
        // Only the message crosses to the renderer, never a stack.
        const msg = err instanceof ValidationError || err instanceof Error ? err.message : String(err)
        throw new Error(msg)
      }
    })
  }

  handle(IPC.snapshot, () => controller.snapshot())
  handle(IPC.sourcesList, () => controller.listSources())
  handle(IPC.sourcesIcon, async (path) => {
    if (typeof path !== 'string' || !controller.isKnownIconPath(path)) return null
    const key = path.toLowerCase()
    if (!iconCache.has(key)) {
      const img = await app.getFileIcon(path, { size: 'large' }).catch(() => null)
      iconCache.set(key, img && !img.isEmpty() ? img.toDataURL() : null)
    }
    return iconCache.get(key) ?? null
  })
  handle(IPC.tokenSet, (token) => controller.setToken(token))
  handle(IPC.tokenClear, () => controller.clearToken())
  handle(IPC.botConnect, () => controller.connectBot())
  handle(IPC.botDisconnect, () => controller.disconnectBot())
  handle(IPC.guildsRefresh, () => controller.refreshGuilds())
  handle(IPC.voiceJoin, (guildId, channelId) =>
    controller.joinChannel(requireSnowflake(guildId, 'guildId'), requireSnowflake(channelId, 'channelId'))
  )
  handle(IPC.voiceLeave, () => controller.leaveChannel())
  handle(IPC.streamStart, (source) => controller.startSharing(validateSourceSelection(source)))
  handle(IPC.streamStop, () => controller.stopSharing())
  handle(IPC.audioVolume, (v) => controller.setAudio({ volume: Math.round(requireNumber(v, 'volume', 0, 200)) }))
  handle(IPC.audioMuted, (m) => controller.setAudio({ muted: requireBoolean(m, 'muted') }))
  handle(IPC.settingsUpdate, (patch) => controller.updateSettings(patch))
  handle(IPC.openExternal, (url) => shell.openExternal(validateExternalUrl(url)))
  handle(IPC.logs, () => controller.getLogs())
}
