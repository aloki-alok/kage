import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../connect.ts', import.meta.url).pathname

function world(config: object, secrets: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-connect-'))
  writeFileSync(`${dir}/config.json`, JSON.stringify({ version: 1, ...config }))
  writeFileSync(`${dir}/secrets.json`, JSON.stringify(secrets), { mode: 0o600 })
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const { KAGE_THREAD: _, KAGE_SESSION: __, ...base } = process.env
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...base, KAGE_ENV: `${dir}/env`, ...extra } })
    return { out: (r.stdout + r.stderr).trim(), code: r.status }
  }
  const read = (f: 'config' | 'secrets') => JSON.parse(readFileSync(`${dir}/${f}.json`, 'utf8'))
  return { run, read }
}

test('kage connect lists every connector with its state and the one step left', () => {
  const w = world({ connectors: { voice: { on: false } } }, { voiceToken: 'v', browserToken: 'b' })
  const r = w.run([])
  assert.equal(r.code, 0)
  assert.match(r.out, /^on {5}browser\s*$/m)
  assert.match(r.out, /^off {4}voice {5}run kage connect voice to turn it back on$/m)
  assert.match(r.out, /^unset {2}github {4}run kage connect github$/m)
})

test('off turns a connector off and names what stays outside Kage, and connect turns it back on', () => {
  const w = world({ connectors: { voice: { port: 9000 }, email: { address: 'k@x.io' } } }, { voiceToken: 'v' })
  const off = w.run(['voice', 'off'])
  assert.equal(off.code, 0)
  assert.match(off.out, /voice is off\..*kage tunnel on/)
  assert.deepEqual(w.read('config').connectors, { voice: { port: 9000, on: false }, email: { address: 'k@x.io' } })
  const on = w.run(['voice'])
  assert.equal(on.code, 0)
  assert.match(on.out, /voice is on\./)
  assert.deepEqual(w.read('config').connectors.voice, { port: 9000 })
  assert.equal(w.read('secrets').voiceToken, 'v')
})

test('a connector that still needs settings says which, and changes nothing', () => {
  const w = world({ connectors: { email: { address: 'k@x.io' } } })
  const r = w.run(['email'])
  assert.equal(r.code, 1)
  assert.match(r.out, /email needs connectors\.email\.queue and connectors\.email\.ownerEmail: kage set <key> <value>/)
  assert.deepEqual(w.read('config').connectors.email, { address: 'k@x.io' })
})

test('connect and off write only when the connector really changes state', () => {
  const never = world({})
  assert.match(never.run(['voice', 'off']).out, /voice is not set up, so it is off already/)
  assert.equal(never.read('config').connectors, undefined)
  const offNoToken = world({ connectors: { voice: { on: false } } })
  const r = offNoToken.run(['voice'])
  assert.equal(r.code, 1)
  assert.match(r.out, /voice needs voiceToken/)
  assert.deepEqual(offNoToken.read('config').connectors, { voice: { on: false } })
  const noBrowser = world({}, { voiceToken: 'v' })
  assert.match(noBrowser.run(['browser', 'off']).out, /browser is not set up, so it is off already/)
})

test('browser off deletes the token the extension pairs with, and says the extension stays in Chrome', () => {
  const w = world({}, { browserToken: 'b', voiceToken: 'v' })
  const r = w.run(['browser', 'off'])
  assert.equal(r.code, 0)
  assert.match(r.out, /chrome:\/\/extensions/)
  assert.deepEqual(w.read('secrets'), { voiceToken: 'v' })
})

test('a name that is not a connector, or an off with no switch yet, is refused with nothing changed', () => {
  const w = world({}, { meetingToken: 'm' })
  const bad = w.run(['slack'])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /github, browser, email, voice, whatsapp or meeting/)
  const meeting = w.run(['meeting', 'off'])
  assert.equal(meeting.code, 1)
  assert.deepEqual(w.read('secrets'), { meetingToken: 'm' })
})

test('a Kage session cannot turn a connector on or off', () => {
  const w = world({}, { voiceToken: 'v' })
  const r = w.run(['voice', 'off'], { KAGE_SESSION: '1' })
  assert.equal(r.code, 1)
  assert.match(r.out, /owner's own terminal/)
  assert.equal(w.read('config').connectors, undefined)
})
