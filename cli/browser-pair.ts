// The native messaging helper Chrome starts for Kage's extension (core/browser-pair.ts). Chrome lets only that
// extension start it. It reads one message and answers with the token and hub address from the settings file,
// read now, so a new token from kage add browser reaches the extension with no paste. stdout is Chrome's channel:
// nothing else may be written to it.
import { readFileSync } from 'node:fs'
import { frame, unframe } from '../core/browser-pair.ts'

const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
const setting = (env: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1]?.trim()

function answer(): unknown {
  let env = ''
  try { env = readFileSync(ENV_FILE, 'utf8') } catch { return { error: `no settings file at ${ENV_FILE}: run kage setup` } }
  const token = setting(env, 'KAGE_BROWSER_TOKEN')
  if (!token) return { error: 'Kage in Chrome is off: run kage add browser' }
  return { token, hub: `http://127.0.0.1:${Number(setting(env, 'KAGE_BROWSER_PORT')) || 8791}` }
}

const chunks: Buffer[] = []
process.stdin.on('data', (c: Buffer) => {
  chunks.push(c)
  // One message is all it serves: answer as soon as it is whole, then exit.
  const m = unframe(Buffer.concat(chunks)) as { want?: unknown } | null | undefined
  if (m === undefined) return
  process.stdout.write(frame(m?.want === 'token' ? answer() : { error: 'not a pairing request' }), () => process.exit(0))
})
process.stdin.on('end', () => process.exit(0))
