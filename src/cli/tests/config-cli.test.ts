import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../config.ts', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'kage-cfgcli-'))
const run = (args: string[], extra: Record<string, string> = {}, input = '') => {
  const { KAGE_THREAD: _, KAGE_SESSION: __, ...base } = process.env
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...base, KAGE_ENV: `${dir}/env`, ...extra } })
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status }
}
run(['save', 'kage'], {}, 'xapp-1-FAKE xoxp-FAKE-user xoxb-FAKE-bot')

test('get never prints a token, and has says only whether one is set', () => {
  assert.equal(run(['get', 'secrets.slack.user']).out, '')
  assert.doesNotMatch(run(['get', 'secrets']).out + run(['get', 'secrets.slack']).out, /FAKE/)
  assert.equal(run(['has', 'secrets.slack.user']).code, 0)
  assert.equal(run(['has', 'secrets.browserToken']).code, 1)
  assert.equal(run(['get', 'name']).out, 'kage')
})

test('a session cannot change a setting, and the owner at a terminal can', () => {
  const before = readFileSync(`${dir}/config.json`, 'utf8')
  for (const marker of [{ KAGE_THREAD: 'C1:5.5' }, { KAGE_SESSION: '1' }] as Record<string, string>[]) {
    const blocked = run(['set', 'harness.maxSessions', '3'], marker)
    assert.equal(blocked.code, 1)
    assert.match(blocked.err, /terminal/)
    assert.equal(run(['save', 'x'], marker, 'xapp-1-FAKE xoxp-FAKE-user xoxb-FAKE-bot').code, 1)
  }
  assert.equal(readFileSync(`${dir}/config.json`, 'utf8'), before)
  assert.equal(run(['set', 'harness.maxSessions', '3']).code, 0)
  assert.equal(run(['get', 'harness.maxSessions']).out, '3')
})

test('save takes the token the transport needs: the signing secret over HTTP, the app token in Socket Mode, and keeps the other one', () => {
  const sig = '0123456789abcdef0123456789abcdef'
  const http = mkdtempSync(join(tmpdir(), 'kage-cfgcli-http-'))
  writeFileSync(`${http}/config.json`, JSON.stringify({ version: 1, slack: { transport: 'http' } }))
  const save = (input: string) => run(['save', 'kage'], { KAGE_ENV: `${http}/env` }, input)
  assert.equal(run(['transport'], { KAGE_ENV: `${http}/env` }).out, 'http')
  assert.match(save('xoxp-FAKE-user xoxb-FAKE-bot').err, /signing secret/)
  assert.equal(save(`${sig} xoxp-FAKE-user xoxb-FAKE-bot`).code, 0)
  const secrets = () => JSON.parse(readFileSync(`${http}/secrets.json`, 'utf8')).slack
  assert.deepEqual(secrets(), { user: 'xoxp-FAKE-user', bot: 'xoxb-FAKE-bot', signing: sig })
  writeFileSync(`${http}/config.json`, JSON.stringify({ version: 1, name: 'kage', slack: { transport: 'socket' } }))
  assert.match(save('xoxp-FAKE-user xoxb-FAKE-bot').err, /xapp-/)
  assert.equal(save('xapp-1-FAKE xoxp-FAKE-user2 xoxb-FAKE-bot').code, 0)
  assert.deepEqual(secrets(), { user: 'xoxp-FAKE-user2', bot: 'xoxb-FAKE-bot', signing: sig, app: 'xapp-1-FAKE' })
})
