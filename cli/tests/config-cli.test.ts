import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
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
