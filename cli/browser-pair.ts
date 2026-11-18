import { frame, unframe } from '../core/browser-pair.ts'
import { envFilePath, readSettings } from '../runtime/config-files.ts'

const ENV_FILE = envFilePath()

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
  const m = unframe(Buffer.concat(chunks)) as { want?: unknown } | null | undefined
  if (m === undefined) return
  process.stdout.write(frame(m?.want === 'token' ? answer() : { error: 'not a pairing request' }), () => process.exit(0))
})
process.stdin.on('end', () => process.exit(0))
