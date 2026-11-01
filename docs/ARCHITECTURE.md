# SyncWave — Architecture

SyncWave captures audio on a Windows PC (the whole system mix, or a single
application) and plays it into a Discord voice channel through a Discord bot
that the app starts, supervises and stops by itself.

## Process model

```
┌──────────────────────────── Electron app ─────────────────────────────┐
│                                                                       │
│  Renderer (React UI)          contextIsolation, sandbox, no Node      │
│        │  window.syncwave.* (preload, typed + whitelisted)            │
│        ▼                                                              │
│  Main process                                                         │
│   • window / tray / single-instance lock / lifecycle                  │
│   • SettingsStore (JSON in userData, schema-validated)                │
│   • TokenVault (Electron safeStorage → DPAPI on Windows)              │
│   • IPC router — every renderer payload is validated                  │
│   • EngineSupervisor — starts/stops/restarts the engine process       │
│        │  MessagePort (structured messages, shared/protocol.ts)       │
│        ▼                                                              │
│  Engine (Electron utilityProcess, Node APIs only)                     │
│   • BotService      discord.js client: login, guilds, voice channels  │
│   • VoiceStreamer   @discordjs/voice connection + player, reconnect   │
│   • CaptureEngine   spawns/controls the native capture helper         │
│   • AudioProcessor  framing, gain ramp, mute, peak/RMS meter          │
│   • OpusPump        Opus encoder + bounded low-latency packet queue   │
│        │  anonymous pipes (stdin = commands, stdout = PCM,            │
│        ▼                        stderr = JSON events)                 │
│  syncwave-capture.exe (C++, WASAPI)                                   │
│   • system loopback  (default render endpoint, AUDCLNT_STREAMFLAGS_   │
│     LOOPBACK)                                                         │
│   • process loopback (ActivateAudioInterfaceAsync +                   │
│     AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, include tree)       │
│   • source enumeration (IAudioSessionManager2 on all render devices)  │
│   • target-process exit watch                                         │
└───────────────────────────────────────────────────────────────────────┘
```

Audio path (all real, no simulation):

```
WASAPI ─► float32/any format ─► helper converts to s16le 48 kHz stereo
       ─► stdout pipe ─► AudioProcessor (20 ms frames, gain, mute, meter)
       ─► Opus encoder (libopus via @discordjs/opus, opusscript fallback)
       ─► bounded packet queue ─► @discordjs/voice AudioPlayer
       ─► encrypted RTP over UDP ─► Discord voice channel
```

## Why these choices

### Native helper process instead of a Node addon
* WASAPI process loopback (`ActivateAudioInterfaceAsync`) needs COM, an
  async completion handler and an MTA thread. That's straightforward in C++
  and awkward from JS.
* A separate executable has no Electron ABI coupling: no rebuild per
  Electron version, and a crash in audio drivers kills the helper, not the
  app. The engine notices the exit and reports it.
* Portability: macOS support means writing another helper (ScreenCaptureKit /
  Core Audio taps) that speaks the same stdio protocol. Nothing above the
  helper changes.

### Transport: anonymous pipes (stdin/stdout/stderr)
Alternatives considered:

| Option                 | Why not                                               |
|------------------------|-------------------------------------------------------|
| localhost TCP/WebSocket| opens a port, may trigger firewall prompts, framing + extra copies, any local process could connect |
| Named pipe             | needs a name + ACL; no gain over anonymous pipes for a parent/child pair |
| Shared memory ring     | lowest latency, but needs a native addon on the Node side (ABI coupling) and manual synchronisation |
| Node native addon      | ABI rebuilds for every Electron upgrade; a driver crash takes down the engine |

Anonymous pipes are private to the parent/child pair, need no ports or
names, give back-pressure for free, and add microseconds of latency, which
doesn't matter next to a 20 ms Opus frame. PCM is 48 kHz × 2 ch × 16 bit
= 192 kB/s, which is tiny for a pipe.

* **stdout** carries only raw PCM (s16le, 48 kHz, stereo, interleaved).
* **stderr** carries newline-delimited JSON events (`ready`, `format`,
  `sources`, `source-ended`, `error`).
* **stdin** carries newline-delimited JSON commands (`stop`).

### Engine in a utilityProcess (not in main)
discord.js, Opus encoding and the voice UDP socket do steady work. Keeping
them out of the main process keeps the UI responsive. The supervisor
restarts the engine with backoff if it crashes. The bot token is sent to the
engine over its private MessagePort, never through argv or env, so other
processes can't read it from the process list.

### Continuous timeline
System loopback delivers no packets while nothing is playing. The helper
tracks wall-clock time and pads silence so the PCM stream is continuous.
Without that, the Opus queue would starve and the level meter would freeze.
The engine caps the packet queue (default 6 frames = 120 ms) and drops the
oldest frames when the capture clock runs ahead of Discord's 20 ms player
clock. That keeps latency bounded under clock drift.

## Security
* The bot token is entered once and encrypted with `safeStorage`
  (DPAPI, bound to the Windows user). It's stored in `userData/token.bin`
  and never sent to the renderer. The renderer only sees `hasToken` and the
  bot's public username/id.
* The renderer runs with `contextIsolation: true`, `sandbox: true` and
  `nodeIntegration: false`, under a strict CSP. Navigation and `window.open`
  are blocked.
* Every IPC payload from the renderer is validated (`shared/validate.ts`)
  before use. Unknown channels are not exposed.
* Sharing starts only from the explicit **Start Sharing** action. Auto-join
  (optional) only joins the channel; it never transmits.
* No microphone capture: the helper only opens render endpoints in loopback
  mode. Protected/DRM audio paths that Windows excludes from loopback stay
  excluded; SyncWave doesn't try to bypass that.
* On quit: stop sharing → leave voice → destroy the client → kill the engine
  → kill the helper. Orphaned helpers also exit on their own when their
  stdout pipe breaks or their parent process dies.

## Limitations
* Per-app capture needs Windows 10 version 2004 (build 19041) or newer.
* Per-app capture captures a process *tree*. SyncWave resolves an audio
  session to its top-level process with the same executable name, so
  Chrome/Edge (whose audio comes from a child "audio service" process) work
  when you pick the browser.
* Some apps play audio through exclusive mode or protected paths (e.g. some
  DRM video). Windows doesn't expose that audio to loopback.
* If you share system audio while you're in the same voice channel with
  Discord's own output, you'll hear an echo. Use per-app capture, or listen
  on another device.
* Discord voice uses a single 48 kHz stereo Opus stream. The bitrate is
  configurable (64–256 kbps; the effective limit depends on the server's
  boost level and channel bitrate).
* One bot = one voice connection per server.

## Manual setup (one time)
See README → "Discord bot setup". In short: create an application in the
Discord Developer Portal, add a bot, copy its token, paste it into SyncWave,
and invite the bot with the link SyncWave generates. No privileged intents
are needed (`Guilds` and `GuildVoiceStates` only).
