// Pairing Kage's Chrome extension with no token to paste (#114). kage add browser registers a native messaging
// helper with each Chromium browser the person has; Chrome lets only Kage's extension (by its id) start it, and
// the helper hands the extension the token from the settings file. The extension's id is fixed by the key in
// extension/manifest.json, so the helper can name it before the extension is ever loaded.
import { createHash } from 'node:crypto'

// Chrome's rule for a native messaging host name: dot-separated lowercase words.
export const HOST = 'dev.kage.pair'

// Chrome's id for an extension: sha256 of its public key (DER), first 32 hex digits, each 0-f written as a-p.
export const extensionId = (keyB64: string) =>
  [...createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')

// The per-user folders each Chromium browser reads helpers from, for the browsers whose profile root exists.
// Windows registers helpers in the registry instead: not handled.
const ROOTS: Record<string, string[]> = {
  darwin: ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data', 'Vivaldi'].map(r => `Library/Application Support/${r}`),
  linux: ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi'].map(r => `.config/${r}`),
}
export const hostDirs = (platform: string, home: string, exists: (path: string) => boolean) =>
  (ROOTS[platform] ?? []).map(r => `${home}/${r}`).filter(exists).map(r => `${r}/NativeMessagingHosts`)

export const hostManifest = (path: string, id: string) => ({
  name: HOST, description: "Hands Kage's Chrome extension its token", path, type: 'stdio' as const,
  allowed_origins: [`chrome-extension://${id}/`],
})

// Chrome's native messaging frame: a 4-byte little-endian length, then that much UTF-8 JSON.
export function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}
export function unframe(buf: Buffer): unknown {
  if (buf.length < 4) return undefined
  const n = buf.readUInt32LE(0)
  if (buf.length < 4 + n) return undefined
  try { return JSON.parse(buf.subarray(4, 4 + n).toString('utf8')) } catch { return undefined }
}
