# SyncWave

Share your PC's audio, or a single app's audio, into a Discord voice channel
through a bot you own. Spotify, Chrome, VLC, a game: pick it, join a channel,
press **Start sharing**.

SyncWave is a Windows 10/11 desktop app (Electron + React + TypeScript) with a
native WASAPI capture engine (C++) and a built-in Discord bot service
(discord.js + @discordjs/voice + libopus).

![SyncWave main window](tests/e2e/screens/2-main.png)

## Features

- **System audio**: WASAPI loopback of the default output device. It follows
  you when you switch output devices. It can leave Discord's own audio out, so
  the people in your call don't hear themselves echo back.
- **Per-app audio**: Windows Process Loopback captures one app and its child
  processes. Chrome, Edge and Electron apps work when you pick the app.
- Lists apps that have audio, shows which ones are **playing right now**, with
  their real icons and window titles.
- If the shared app closes, sharing stops cleanly and you get a notification.
- You can switch the source while live. The bot stays in the channel.
- Discord: the bot starts with the app. You see servers and voice channels with
  listener counts and permission checks. Join, leave, auto-reconnect with
  backoff, follow the bot if someone moves it, and stage channels.
- Controls: Start/Stop, Mute (click-free ramp), Volume 0–200 %, stereo
  peak/RMS meter with peak hold, a live radial visualizer, and stats (bitrate,
  buffer, ping, listeners, dropped frames, encoder).
- Tray icon with Start/Stop/Mute/Leave, notifications while hidden.
- Settings persist: bitrate, max buffer, exclude Discord, default/last
  source, auto-connect, rejoin last channel, launch at login, start minimized,
  close to tray.

## How it works

```
syncwave-capture.exe (WASAPI) ──PCM pipe──► Engine (utilityProcess)
                                              ├─ 20 ms framing, gain, mute, meter
                                              ├─ Opus encode (libopus, music mode, FEC)
                                              ├─ bounded low-latency packet queue
                                              └─ @discordjs/voice ──UDP──► Discord
Main process: window, tray, settings, encrypted token, validated IPC, engine supervisor
Renderer: React UI (sandboxed, contextIsolation, no Node)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, including
**why the transport is anonymous stdio pipes** (private to the parent/child
pair, no ports or firewall prompts, back-pressure for free, no Electron ABI
coupling) and how latency stays bounded when the sound card's clock and
Discord's 20 ms clock drift apart.

## Discord bot setup (one time, ~2 minutes)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application** → give it a name (e.g. *SyncWave*).
2. Go to **Bot** → **Reset Token** → copy the token.
   - **Privileged Gateway Intents: leave all off.** SyncWave only uses the
     `Guilds` and `GuildVoiceStates` intents.
   - Turning off *Public Bot* is recommended, so only you can invite it.
3. Start SyncWave, paste the token in the setup window → **Save & connect**.
4. Click **Open invite link**. The link SyncWave generates asks only for
   *View Channel*, *Connect* and *Speak* (`permissions=3146752`, `scope=bot`).
   Pick your server and authorize.
5. Pick a voice channel on the left, pick a source on the right, press
   **Start sharing**.

> Never paste your personal Discord account token. SyncWave only accepts a
> bot token, and using a user token ("self-bot") is against Discord's Terms.

**Where the token goes:** the main process encrypts it with Electron
`safeStorage` (Windows DPAPI, tied to your Windows account) and saves it to
`%APPDATA%\SyncWave\token.bin`. The UI never receives it back. It travels only
to the engine over a private message port, never via command line or
environment. *Settings → Bot token → Remove* deletes it.

## Install

Run `release\SyncWave-Setup-1.0.0.exe`. It's a per-user install with no admin
rights, and you can choose the folder. The installer is **not code-signed**, so
Windows SmartScreen may warn you: *More info → Run anyway*.

## Build from source

Requirements:
- Windows 10 2004+ / Windows 11, x64
- Node.js 22+ (tested with 24) and npm 11
- Visual Studio 2019+ Build Tools with **Desktop development with C++**
  (MSVC + Windows 10/11 SDK). Only needed to rebuild the native capture
  helper.
- Python 3 (only to regenerate icons: `python scripts/make-icons.py`)

```bash
npm install
npm run build:native   # builds resources/bin/syncwave-capture.exe
npm run dev            # run with hot reload
npm run dist           # build:native + build + NSIS installer → release/
```

`npm install` runs `scripts/fix-opus-binding.cjs`, which makes the N-API
libopus binary loadable under Electron. The `allowScripts` field in
`package.json` approves the two install scripts npm 11 would otherwise block
(`@discordjs/opus`, `electron-winstaller`). If libopus can't load at all,
SyncWave falls back to `opusscript` and says so in *Settings → Activity log*.

No environment variables are needed to run the app. For tests only:

| Variable | Purpose |
|---|---|
| `SYNCWAVE_USER_DATA` | Use a throwaway profile folder (the e2e test sets this) |
| `SYNCWAVE_EXE` | Point the e2e test at a packaged `SyncWave.exe` |
| `SYNCWAVE_E2E_NETWORK=1` | Let the e2e test make one login attempt with a fake token |

## Tests

```bash
npm test               # unit: validation, settings, token vault, framing, gain/mute,
                       #       meters, Opus round-trip, latency queue, stream lifecycle
npm run test:native    # real capture helper on this PC (plays a quiet 440 Hz tone ~3 s)
npm run test:e2e       # builds and drives the real app UI with Playwright
npm run typecheck
```

`test:native` includes a **pipeline test**: it captures a tone-playing process
with per-app capture, runs it through framing → gain → libopus → the latency
queue → the real `@discordjs/voice` `AudioPlayer`, decodes the packets the
player sends, and checks that they contain the tone and keep real-time pace.

## What has been verified, and what hasn't

Verified on Windows 10 Pro 19045:
- System loopback, per-app loopback and "system minus Discord" capture, with
  real audio levels; continuous 48 kHz output with silence padding; source
  exit detection; clean stop.
- Full pipeline capture → Opus → `AudioPlayer` (packets decoded and checked).
- The app UI, engine start-up, native libopus + DAVE library loading, IPC
  validation, settings persistence, malformed-token rejection, Discord's
  rejection of an invalid token, clean shutdown with no leftover processes.
  Checked in dev **and** in the packaged `win-unpacked` build.

**Not verified yet (needs your bot token and a second person):**
- Logging in with a real bot, listing real servers/channels, joining a voice
  channel, and a listener actually hearing the stream, including sound
  quality, real-world latency, reconnect after network loss, and being
  moved or kicked.
- The NSIS installer was built but not run through install/uninstall here.

## Limitations

- Per-app capture needs Windows 10 version 2004 (build 19041) or newer.
- DRM-protected playback and exclusive-mode audio aren't available to
  loopback capture. SyncWave doesn't try to bypass that.
- If you're in the same channel and share **system** audio, keep *Leave
  Discord out of system audio* on, or you'll get an echo.
- Discord limits the effective bitrate to the channel's setting (64–96 kbps on
  unboosted servers).
- One voice channel at a time. If the engine crashes, it restarts and
  reconnects the bot, but you have to rejoin the channel.

## Project layout

```
native/capture/      C++ WASAPI helper (list, system/process/exclude loopback)
src/main/            Electron main: lifecycle, tray, IPC, settings, token vault, engine host
src/preload/         contextBridge API (window.syncwave)
src/engine/          utilityProcess: bot, voice, capture, processing, Opus, queue
src/shared/          types, engine protocol, validation
src/renderer/        React UI
tests/unit|native|e2e
docs/ARCHITECTURE.md
```

## macOS later

Everything above the capture helper is platform-neutral. A macOS port needs
a helper with the same stdio protocol (ScreenCaptureKit or Core Audio process
taps), a `.icns` icon and an electron-builder `mac` target.

---

### بالعربية: البدء السريع

1. ثبّت التطبيق من `release\SyncWave-Setup-1.0.0.exe`.
2. أنشئ بوت من [Developer Portal](https://discord.com/developers/applications)، ثم من تبويب **Bot** اضغط **Reset Token** وانسخ التوكن. لا تحتاج إلى أي Intents مميزة.
3. الصق التوكن في نافذة الإعداد، ثم اضغط **Open invite link** وأضف البوت إلى سيرفرك.
4. اختر روماً صوتياً من اليسار، ومصدر الصوت من اليمين (صوت النظام أو تطبيق معيّن)، ثم اضغط **Start sharing**.

لا تضع توكن حسابك الشخصي أبداً، بل توكن البوت فقط. يُخزَّن التوكن مشفّراً على جهازك.
