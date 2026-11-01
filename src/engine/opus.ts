// Opus encoder wrapper. Prefers native libopus (@discordjs/opus); falls back to
// opusscript (libopus compiled to JS) if the native binding can't load.
import { createRequire } from 'module'
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from '@shared/protocol'

const require = createRequire(__filename)

export interface Encoder {
  readonly kind: 'libopus' | 'opusscript'
  encode(pcm: Buffer): Buffer
  setBitrate(bps: number): void
  destroy(): void
}

// libopus CTL request codes (opus_defines.h).
const OPUS_SET_INBAND_FEC = 4012
const OPUS_SET_PACKET_LOSS_PERC = 4014
const OPUS_SET_SIGNAL = 4024
const OPUS_SIGNAL_MUSIC = 3002

export function createEncoder(bitrateKbps: number, prefer: 'auto' | 'opusscript' = 'auto'): Encoder {
  if (prefer === 'auto') {
    try {
      const { OpusEncoder } = require('@discordjs/opus')
      const enc = new OpusEncoder(SAMPLE_RATE, CHANNELS)
      enc.setBitrate(bitrateKbps * 1000)
      // Music-tuned, with in-band FEC so a lost UDP packet degrades gracefully.
      enc.applyEncoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC)
      enc.applyEncoderCTL(OPUS_SET_INBAND_FEC, 1)
      enc.applyEncoderCTL(OPUS_SET_PACKET_LOSS_PERC, 5)
      return {
        kind: 'libopus',
        encode: (pcm) => enc.encode(pcm),
        setBitrate: (bps) => enc.setBitrate(bps),
        destroy: () => {}
      }
    } catch {
      // fall through to opusscript
    }
  }
  const OpusScript = require('opusscript')
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO)
  enc.setBitrate(bitrateKbps * 1000)
  enc.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC)
  enc.encoderCTL(OPUS_SET_INBAND_FEC, 1)
  enc.encoderCTL(OPUS_SET_PACKET_LOSS_PERC, 5)
  return {
    kind: 'opusscript',
    encode: (pcm) => Buffer.from(enc.encode(pcm, FRAME_SAMPLES)),
    setBitrate: (bps) => enc.setBitrate(bps),
    destroy: () => enc.delete()
  }
}
