import { createHash } from 'node:crypto'

export const HOST = 'dev.kage.pair'

export const extensionId = (keyB64: string) =>
  [...createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')

const ROOTS: Record<string, [name: string, root: string][]> = {
  darwin: [['Chrome', 'Google/Chrome'], ['Chrome Beta', 'Google/Chrome Beta'], ['Chrome Canary', 'Google/Chrome Canary'], ['Chromium', 'Chromium'], ['Brave', 'BraveSoftware/Brave-Browser'], ['Microsoft Edge', 'Microsoft Edge'], ['Arc', 'Arc/User Data'], ['Vivaldi', 'Vivaldi']]
    .map(([n, r]) => [n!, `Library/Application Support/${r}`]),
  linux: [['Chrome', 'google-chrome'], ['Chrome Beta', 'google-chrome-beta'], ['Chrome Unstable', 'google-chrome-unstable'], ['Chromium', 'chromium'], ['Brave', 'BraveSoftware/Brave-Browser'], ['Microsoft Edge', 'microsoft-edge'], ['Vivaldi', 'vivaldi']]
    .map(([n, r]) => [n!, `.config/${r}`]),
}
export const hostBrowsers = (platform: string, home: string, exists: (path: string) => boolean) =>
  (ROOTS[platform] ?? []).map(([name, r]) => ({ name, root: `${home}/${r}` })).filter(b => exists(b.root)).map(b => ({ name: b.name, dir: `${b.root}/NativeMessagingHosts` }))

export function addBrowserLines(f: { names: string[]; ext: string; token: string; showToken: boolean; platform: string; opened: boolean; revealed: boolean }): string[] {
  const paired = f.names.length > 0
  return [
    paired ? `Kage in Chrome is on. Pairing is set up for ${f.names.join(', ')}, so there is nothing to paste. Kage picks up the new token by itself once its sessions are quiet.`
      : 'Kage in Chrome is on, but no Chromium browser was found to pair. Paste the token below in the Kage toolbar icon after step 2.',
    '',
    f.opened ? '1. On the Extensions page that just opened, turn on Developer mode.' : '1. In Chrome, open chrome://extensions and turn on Developer mode.',
    f.revealed ? '2. Drag the highlighted extension folder from the Finder window onto the Extensions page.' : `2. Click Load unpacked, go to ${f.ext.replace(/\/[^/]+\/?$/, '')}, click the extension folder once, then click Select.`,
    ...(f.showToken || !paired ? ['', `Token: ${f.token}`] : []),
    `Sites Kage must never read: run kage set connectors.browser.block '["bank.example.com","1password.com"]'`,
  ]
}

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
  try { return JSON.parse(buf.subarray(4, 4 + n).toString('utf8')) } catch { return { error: 'not JSON' } }
}
