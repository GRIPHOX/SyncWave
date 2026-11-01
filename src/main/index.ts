// Main process entry: window, tray, single instance, startup and shutdown.
import { BrowserWindow, Menu, Notification, Tray, app, nativeImage, safeStorage, session, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/api'
import type { AppSnapshot } from '@shared/types'
import { AppController } from './controller'
import { EngineHost } from './engineHost'
import { registerIpc } from './ipc'
import { SettingsStore } from './settings'
import { TokenVault } from './tokenVault'

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
const asset = (name: string): string => join(resources, name)

// Tests run against a throwaway profile so they never touch the real token.
if (process.env.SYNCWAVE_USER_DATA) app.setPath('userData', process.env.SYNCWAVE_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setAppUserModelId('com.griphox.syncwave')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let controller: AppController
let engine: EngineHost
let lastTrayKey = ''

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0b12',
    title: 'SyncWave',
    icon: asset('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#b9b7d6', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  win.on('ready-to-show', () => {
    if (show) win?.show()
  })
  win.on('close', (e) => {
    if (!quitting && controller.snapshot().settings.startup.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow(true)
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'SyncWave', body, icon: asset('icon.png') }).show()
}

function updateTray(s: AppSnapshot): void {
  if (!tray) return
  const live = s.state.stream.status === 'live'
  const connected = s.state.voice.status === 'connected'
  const muted = s.settings.audio.muted
  const key = `${live}|${connected}|${muted}|${s.state.stream.sourceLabel}|${s.state.voice.channelName}`
  if (key === lastTrayKey) return
  lastTrayKey = key
  tray.setImage(nativeImage.createFromPath(asset(live ? 'tray-live.png' : 'tray.png')).resize({ width: 16, height: 16 }))
  tray.setToolTip(
    live ? `SyncWave: sharing ${s.state.stream.sourceLabel} to #${s.state.voice.channelName}` : 'SyncWave: not sharing'
  )
  const run = (fn: () => Promise<unknown>) => () => void fn().catch((e) => notify((e as Error).message))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open SyncWave', click: showWindow },
      { type: 'separator' },
      live
        ? { label: 'Stop sharing', click: run(() => controller.stopSharing()) }
        : {
            label: connected ? 'Start sharing (default source)' : 'Start sharing (join a channel first)',
            enabled: connected,
            click: run(() => controller.startDefault())
          },
      { label: 'Mute', type: 'checkbox', checked: muted, click: run(() => controller.setAudio({ muted: !muted })) },
      { label: 'Leave voice channel', enabled: connected, click: run(() => controller.leaveChannel()) },
      { type: 'separator' },
      { label: 'Quit SyncWave', click: () => app.quit() }
    ])
  )
}

function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return // don't register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

function lockDownSessions(): void {
  // No permission (mic, camera, notifications…) is ever granted to web content.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'"
          ]
        }
      })
    })
  }
}

app.whenReady().then(() => {
  lockDownSessions()
  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.json'))
  const vault = new TokenVault(join(userData, 'token.bin'), safeStorage)

  const captureExe = join(resources, 'bin', 'syncwave-capture.exe')
  engine = new EngineHost(join(__dirname, 'engine.js'), [`--capture-exe=${captureExe}`, `--host-pid=${process.pid}`])
  controller = new AppController(engine, settings, vault, app.getVersion())

  const isTrusted = (wc: Electron.WebContents): boolean => !!win && wc.id === win.webContents.id
  registerIpc(controller, isTrusted)

  controller.on('snapshot', (s) => {
    win?.webContents.send(IPC.evSnapshot, s)
    updateTray(s)
  })
  controller.on('levels', (l) => win?.webContents.send(IPC.evLevels, l))
  controller.on('log', (e) => win?.webContents.send(IPC.evLog, e))

  // Notify about things that happen while the window is hidden.
  let prevStream = ''
  controller.on('snapshot', (s) => {
    const st = s.state.stream
    const key = `${st.status}|${st.notice}|${st.error}`
    if (key !== prevStream && !win?.isVisible()) {
      if (st.notice) notify(st.notice)
      else if (st.status === 'error' && st.error) notify(st.error)
    }
    prevStream = key
  })

  const start = settings.get().startup
  applyLoginItem(start.launchAtLogin)
  let lastLogin = start.launchAtLogin
  controller.on('snapshot', (s) => {
    if (s.settings.startup.launchAtLogin !== lastLogin) {
      lastLogin = s.settings.startup.launchAtLogin
      applyLoginItem(lastLogin)
    }
  })

  tray = new Tray(nativeImage.createFromPath(asset('tray.png')).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  updateTray(controller.snapshot())

  const hidden = process.argv.includes('--hidden') || start.startMinimized
  createWindow(!hidden)
  engine.start()
})

app.on('second-instance', showWindow)

app.on('window-all-closed', () => {
  // Stay alive in the tray; quitting goes through before-quit.
})

app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // Clean shutdown: stop sharing, leave voice, log the bot out, end the helper.
  void (engine?.stop() ?? Promise.resolve()).finally(() => {
    tray?.destroy()
    app.exit(0)
  })
})

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://discord.com/')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})
