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
const ROOTS: Record<string, [name: string, root: string][]> = {
  darwin: [['Chrome', 'Google/Chrome'], ['Chrome Beta', 'Google/Chrome Beta'], ['Chrome Canary', 'Google/Chrome Canary'], ['Chromium', 'Chromium'], ['Brave', 'BraveSoftware/Brave-Browser'], ['Microsoft Edge', 'Microsoft Edge'], ['Arc', 'Arc/User Data'], ['Vivaldi', 'Vivaldi']]
    .map(([n, r]) => [n!, `Library/Application Support/${r}`]),
  linux: [['Chrome', 'google-chrome'], ['Chrome Beta', 'google-chrome-beta'], ['Chrome Unstable', 'google-chrome-unstable'], ['Chromium', 'chromium'], ['Brave', 'BraveSoftware/Brave-Browser'], ['Microsoft Edge', 'microsoft-edge'], ['Vivaldi', 'vivaldi']]
    .map(([n, r]) => [n!, `.config/${r}`]),
}
export const hostBrowsers = (platform: string, home: string, exists: (path: string) => boolean) =>
  (ROOTS[platform] ?? []).map(([name, r]) => ({ name, root: `${home}/${r}` })).filter(b => exists(b.root)).map(b => ({ name: b.name, dir: `${b.root}/NativeMessagingHosts` }))

// What kage add browser prints: only the steps Chrome leaves to the person. Chrome lets no script install an
// unpacked extension, so Developer mode and Load unpacked stay. `opened`: the extensions page was opened for them.
// `copied`: the folder path is on their clipboard. The token shows only with --show-token, or when no browser was paired.
export function addBrowserLines(f: { names: string[]; ext: string; token: string; showToken: boolean; platform: string; opened: boolean; revealed: boolean }): string[] {
  const paired = f.names.length > 0
  return [
    paired ? `Kage in Chrome is on. Pairing is set up for ${f.names.join(', ')}, so there is nothing to paste. Kage picks up the new token by itself once its sessions are quiet.`
      : 'Kage in Chrome is on, but no Chromium browser was found to pair. Paste the token below in the Kage toolbar icon after step 2.',
    '',
    f.opened ? '1. On the Extensions page that just opened, turn on Developer mode.' : '1. In Chrome, open chrome://extensions and turn on Developer mode.',
    // Not Load unpacked with a pasted path: that dialog lands inside the folder, where there is nothing to pick.
    f.revealed ? '2. Drag the highlighted extension folder from the Finder window onto the Extensions page.' : `2. Click Load unpacked, go to ${f.ext.replace(/\/[^/]+\/?$/, '')}, click the extension folder once, then click Select.`,
    ...(f.showToken || !paired ? ['', `Token: ${f.token}`] : []),
    `Sites Kage must never read: run kage set connectors.browser.block '["bank.example.com","1password.com"]'`,
  ]
}

// Run again on a paired install, kage add browser changes nothing: a new token would cut the working extension
// off, and Finder and the Extensions page are only for a first install. --reinstall does the whole first-run setup again.
export const addBrowserPlan = (f: { hasToken: boolean; reinstall: boolean }) =>
  f.hasToken && !f.reinstall ? { newToken: false, open: false } : { newToken: true, open: true }

export const addBrowserAgainLines = () => [
  'Kage in Chrome is already set up, so nothing changed. Run kage doctor to see whether it is connected.',
  'If it is not: in chrome://extensions, turn Kage on if it is off, then click its reload arrow.',
  'If Kage is not listed there at all, run kage add browser --reinstall.',
]

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
  // A whole frame that is not JSON is answered as an error: waiting for more would hang the helper.
  try { return JSON.parse(buf.subarray(4, 4 + n).toString('utf8')) } catch { return { error: 'not JSON' } }
}
