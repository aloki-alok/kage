import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { addBrowserLines, extensionId, frame, HOST, hostBrowsers, hostManifest, unframe } from '../browser-pair.ts'

test('the extension id is the first 16 bytes of the key hash, written in the letters a to p', () => {
  const key = Buffer.from('a public key, as DER').toString('base64')
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  const id = extensionId(key)
  assert.match(id, /^[a-p]{32}$/)
  assert.equal(id, [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''))
})

test('the helper is offered to every Chromium browser the person has, on macOS and on Linux', () => {
  const has = (dirs: string[]) => (p: string) => dirs.some(d => p === d)
  const dirs = (...a: Parameters<typeof hostBrowsers>) => hostBrowsers(...a).map(b => b.dir)
  const mac = dirs('darwin', '/Users/test', has(['/Users/test/Library/Application Support/Google/Chrome', '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser']))
  assert.deepEqual(mac, [
    '/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  ])
  const linux = dirs('linux', '/home/test', has(['/home/test/.config/chromium']))
  assert.deepEqual(linux, ['/home/test/.config/chromium/NativeMessagingHosts'])
  assert.deepEqual(dirs('win32', 'C:/x', () => true), [])
})

test("only Kage's extension may start the helper", () => {
  const m = hostManifest('/opt/kage/pair.sh', 'abcdefghijklmnopabcdefghijklmnop')
  assert.equal(m.name, HOST)
  assert.equal(m.type, 'stdio')
  assert.equal(m.path, '/opt/kage/pair.sh')
  assert.deepEqual(m.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
  assert.match(HOST, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
})

test("a message survives Chrome's framing both ways, and a short read is not a message", () => {
  const f = frame({ token: 't', hub: 'http://127.0.0.1:8791' })
  assert.equal(f.readUInt32LE(0), f.length - 4)
  assert.deepEqual(unframe(f), { token: 't', hub: 'http://127.0.0.1:8791' })
  assert.equal(unframe(f.subarray(0, 6)), undefined)
  assert.equal(unframe(Buffer.alloc(2)), undefined)
})

test('the key in the manifest gives the id real Chromium gave the extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'))
  assert.equal(extensionId(manifest.key), 'mbmhceabkblejmogdbncbcpmamkldiek')
})

test('a whole frame that is not JSON is an error, not a wait for more', () => {
  const body = Buffer.from('{x}')
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0)
  assert.deepEqual(unframe(Buffer.concat([head, body])), { error: 'not JSON' })
})

test('each browser is listed by its real name, not by a folder in its path', () => {
  const root = '/Users/test/Library/Application Support/'
  const have = ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data', 'Vivaldi']
  const mac = hostBrowsers('darwin', '/Users/test', p => have.some(h => p === root + h))
  assert.deepEqual(mac.map(b => b.name), ['Chrome', 'Chromium', 'Brave', 'Microsoft Edge', 'Arc', 'Vivaldi'])
  assert.equal(mac[4]!.dir, `${root}Arc/User Data/NativeMessagingHosts`)
  assert.deepEqual(hostBrowsers('linux', '/home/t', p => p === '/home/t/.config/google-chrome').map(b => b.name), ['Chrome'])
})

const base = { names: ['Chrome', 'Brave'], ext: '/opt/kage/extension', token: 'tok-fake', showToken: false, platform: 'darwin', opened: true, copied: true }

test('a paired browser gets only the steps Chrome leaves, and no token', () => {
  const out = addBrowserLines(base).join('\n')
  assert.match(out, /Pairing is set up for Chrome, Brave/)
  assert.match(out, /Developer mode/)
  assert.match(out, /Load unpacked/)
  assert.match(out, /Cmd\+Shift\+G/)
  assert.doesNotMatch(out, /tok-fake|kage restart|opt\/kage/)
})

test('when the page or the clipboard did not work, the steps name the page and the path', () => {
  const out = addBrowserLines({ ...base, opened: false, copied: false, platform: 'linux' }).join('\n')
  assert.match(out, /open chrome:\/\/extensions/)
  assert.match(out, /\/opt\/kage\/extension/)
  assert.doesNotMatch(out, /Cmd\+Shift\+G/)
})

test('--show-token prints the token, and a machine with no browser to pair needs it', () => {
  assert.match(addBrowserLines({ ...base, showToken: true }).join('\n'), /tok-fake/)
  const none = addBrowserLines({ ...base, names: [] }).join('\n')
  assert.match(none, /tok-fake/)
  assert.match(none, /no Chromium browser/i)
})
