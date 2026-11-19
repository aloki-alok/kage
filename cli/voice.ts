import { FLICKER, painter } from '../core/voice.ts'

export const voice = painter(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
export const errVoice = painter(Boolean(process.stderr.isTTY) && !process.env.NO_COLOR)

export function flicker(label: string): () => void {
  if (!process.stdout.isTTY) return () => {}
  const started = Date.now()
  let frame = 0
  const draw = () => process.stdout.write(`\r\x1b[2K  ${voice.fire(FLICKER[frame++ % FLICKER.length]!)} ${voice.dim(`${label} · ${Math.round((Date.now() - started) / 1000)} s`)}`)
  draw()
  const timer = setInterval(draw, 250)
  return () => { clearInterval(timer); process.stdout.write('\r\x1b[2K') }
}
