// The native messaging helper Chrome starts for Kage's extension (core/browser-pair.ts). Chrome lets only that
// extension start it. It reads one message and answers with the token and hub address from the settings file,
// read now, so a new token from kage add browser reaches the extension with no paste. stdout is Chrome's channel:
// nothing else may be written to it.
import { frame, unframe } from '../core/browser-pair.ts'
import { readSettings } from '../runtime/config-files.ts'

const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`

function answer(): unknown {
  let s
  try { s = readSettings(ENV_FILE) } catch { return { error: `no settings in ${ENV_FILE.replace(/\/[^/]*$/, '')}: run kage setup` } }
  const token = s.secrets.browserToken
  if (!token) return { error: 'Kage in Chrome is off: run kage add browser' }
  return { token, hub: `http://127.0.0.1:${s.config.connectors?.browser?.port || 8791}` }
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
