import { painter } from '../core/voice.ts'

export const voice = painter(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
export const errVoice = painter(Boolean(process.stderr.isTTY) && !process.env.NO_COLOR)
