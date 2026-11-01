// Engine entry point. Runs in an Electron utilityProcess and talks to the main
// process over process.parentPort. Hosts the bot, voice and audio pipeline.
import { generateDependencyReport } from '@discordjs/voice'
import type { EngineMessage, EngineRequest, EngineRequestEnvelope } from '@shared/protocol'
import type { EngineState } from '@shared/types'
import { BotService, voiceChannelInfo } from './bot'
import { CaptureEngine } from './capture'
import { createEncoder } from './opus'
import { StreamController } from './stream'
import { VoiceStreamer } from './voice'

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

function arg(name: string): string {
  const prefix = `--${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  if (!found) throw new Error(`engine: missing ${prefix}`)
  return found.slice(prefix.length)
}

const send = (msg: EngineMessage): void => parentPort.postMessage(msg)
const log = (level: 'info' | 'warn' | 'error', message: string): void => send({ type: 'log', level, message })

const capture = new CaptureEngine(arg('capture-exe'), Number(arg('host-pid')))
const bot = new BotService()
const voice = new VoiceStreamer()
const stream = new StreamController(capture, voice)

let guilds: EngineState['guilds'] = []
let pending = false
function publish(): void {
  if (pending) return
  pending = true
  setImmediate(() => {
    pending = false
    send({ type: 'state', state: { bot: bot.current, voice: voice.current, stream: stream.current, guilds } })
  })
}

bot.on('state', publish)
bot.on('guilds', (g) => {
  guilds = g
  publish()
})
bot.on('voiceUpdate', (guildId) => {
  if (voice.current.guildId === guildId) voice.refreshChannel()
})
voice.on('state', publish)
voice.on('ended', () => {
  if (stream.live) void stream.stop('Left the voice channel, so sharing stopped.')
})
stream.on('state', publish)
stream.on('levels', (levels) => send({ type: 'levels', levels }))
for (const emitter of [bot, voice, stream]) emitter.on('log', log)

async function handle(req: EngineRequest): Promise<unknown> {
  switch (req.type) {
    case 'bot:login':
      voice.leave()
      await stream.stop()
      await bot.login(req.token)
      return
    case 'bot:logout':
      await stream.stop()
      voice.leave()
      await bot.logout()
      return
    case 'guilds:refresh':
      bot.publishGuilds()
      return
    case 'voice:join': {
      const channel = bot.getVoiceChannel(req.guildId, req.channelId)
      const info = voiceChannelInfo(channel)
      if (!info.canConnect)
        throw new Error(`The bot can't join #${channel.name}: it needs View Channel + Connect, or the channel is full.`)
      if (!info.canSpeak) throw new Error(`The bot can't speak in #${channel.name}: give it the Speak permission.`)
      await voice.join(channel)
      return
    }
    case 'voice:leave':
      await stream.stop()
      voice.leave()
      return
    case 'sources:list':
      return capture.listSources()
    case 'stream:start':
      if (!voice.connected && voice.current.status !== 'reconnecting')
        throw new Error('Join a voice channel before you start sharing.')
      await stream.start(req.source, req.excludeDiscord)
      return
    case 'stream:stop':
      await stream.stop()
      return
    case 'audio:config':
      stream.setConfig(req)
      return
    case 'shutdown':
      await shutdown()
      return
  }
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const hardExit = setTimeout(() => process.exit(0), 3000)
  try {
    await stream.stop()
    voice.leave()
    await bot.logout()
  } finally {
    clearTimeout(hardExit)
    setImmediate(() => process.exit(0))
  }
}

parentPort.on('message', async (e) => {
  const env = e.data as EngineRequestEnvelope
  if (!env || typeof env.id !== 'number' || !env.request) return
  try {
    const result = await handle(env.request)
    send({ type: 'reply', id: env.id, ok: true, result })
  } catch (err) {
    send({ type: 'reply', id: env.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

process.on('exit', () => stream.kill())
process.on('uncaughtException', (err) => log('error', `Engine error: ${err.stack ?? err.message}`))
process.on('unhandledRejection', (err) => log('error', `Engine promise error: ${String(err)}`))

// Report which Opus implementation loaded (native libopus or the JS fallback).
try {
  const probe = createEncoder(128)
  // Discord voice needs AES-GCM transport encryption and DAVE end-to-end encryption.
  const report = generateDependencyReport()
  const dave = /@snazzah\/davey: (\S+)/.exec(report)?.[1] ?? 'not found'
  const gcm = /aes-256-gcm: (\S+)/.exec(report)?.[1] ?? 'no'
  log('info', `Engine ready (Opus: ${probe.kind}, DAVE: ${dave}, AES-GCM: ${gcm})`)
  probe.destroy()
} catch (err) {
  log('error', `No Opus encoder available: ${(err as Error).message}`)
}

send({ type: 'ready' })
publish()
