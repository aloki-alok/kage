import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { extensionId, frame, HOST, hostDirs, hostManifest, unframe } from '../browser-pair.ts'

test('the extension id is the first 16 bytes of the key hash, written in the letters a to p', () => {
  const key = Buffer.from('a public key, as DER').toString('base64')
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  const id = extensionId(key)
  assert.match(id, /^[a-p]{32}$/)
  assert.equal(id, [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''))
})

test('the helper is offered to every Chromium browser the person has, on macOS and on Linux', () => {
  const has = (dirs: string[]) => (p: string) => dirs.some(d => p === d)
  const mac = hostDirs('darwin', '/Users/test', has(['/Users/test/Library/Application Support/Google/Chrome', '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser']))
  assert.deepEqual(mac, [
    '/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  ])
  const linux = hostDirs('linux', '/home/test', has(['/home/test/.config/chromium']))
  assert.deepEqual(linux, ['/home/test/.config/chromium/NativeMessagingHosts'])
  assert.deepEqual(hostDirs('win32', 'C:/x', () => true), [])
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
