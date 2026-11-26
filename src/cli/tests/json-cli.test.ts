import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../../runtime/store.ts'
import { ensureTrustTable, trustLinesOf } from '../../runtime/trust-store.ts'

const dir = mkdtempSync(join(tmpdir(), 'kage-json-'))
writeFileSync(join(dir, 'config.json'), '{"version":1}')
const store = openStore(join(dir, 'kage.db'))
store.addSchedule({ id: 'j1', key: 'C0TEST1:5.5', cron: '0 9 * * 1', prompt: 'check the deploy', recurring: true, fromOwner: true, created: 1, lastFired: 0 })
const db = new DatabaseSync(join(dir, 'kage.db'))
ensureTrustTable(db)
trustLinesOf(db).addTrustLine({ who: 'U0TEST1', kind: 'repo-read', reach: 'github.com/acme/app', answer: 'yes', once: false, link: 'https://x.test/p' }, Date.parse('2026-11-25T00:00:00Z'))
db.close()

const kage = (...args: string[]) => spawnSync('bash', [new URL('../../../setup.sh', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '' } })
const json = (...args: string[]) => {
  const r = kage(...args, '--json')
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
  return JSON.parse(r.stdout) as unknown
}

test('schedule list --json gives one row per schedule with its fields', () => {
  const [row] = json('schedule', 'list') as Record<string, unknown>[]
  assert.deepEqual(Object.keys(row!).sort(), ['blocked', 'fromOwner', 'id', 'key', 'model', 'next', 'paused', 'place', 'prompt', 'recurring', 'trigger', 'when'])
  assert.equal(row!.id, 'j1')
  assert.equal(row!.prompt, 'check the deploy')
})
test('trust list --json gives the lines', () => {
  const [line] = json('trust', 'list') as Record<string, unknown>[]
  assert.deepEqual({ id: line!.id, who: line!.who, kind: line!.kind, reach: line!.reach, answer: line!.answer }, { id: 'T1', who: 'U0TEST1', kind: 'repo-read', reach: 'github.com/acme/app', answer: 'yes' })
})
test('person, kagelet, connector and cost lists give arrays, even when empty', () => {
  for (const args of [['person', 'list'], ['kagelet', 'list'], ['connector', 'list'], ['cost', '7']]) assert.ok(Array.isArray(json(...args)), args.join(' '))
  const connectors = json('connector', 'list') as { name: string; state: string }[]
  assert.ok(connectors.some(c => c.name === 'email' && ['on', 'off', 'unset'].includes(c.state)))
})
test('config list --json gives every setting, and config get --json one', () => {
  const all = json('config', 'list') as { key: string }[]
  assert.ok(all.some(s => s.key === 'harness.maxSessions'))
  assert.deepEqual(Object.keys(json('config', 'get', 'harness.maxSessions') as object).sort(), ['default', 'key', 'text', 'value'])
})
test('stats --json gives the numbers behind kage stats', () => {
  const s = json('stats', '3') as { days: number; perDay: unknown[]; runs: object }
  assert.equal(s.days, 3)
  assert.equal(s.perDay.length, 3)
  assert.deepEqual(s.runs, { started: 0, ended: 0, refusals: 0 })
})
test('--json may come before the key or name', () => {
  for (const args of [['config', 'get', '--json', 'harness.maxSessions'], ['config', 'get', 'harness.maxSessions', '--jq', '.key'], ['cost', '--json', '7']]) {
    const r = kage(...args)
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
  }
  assert.equal(kage('config', 'get', '--json').status, 2)
})
test('--jq filters the rows', () => {
  assert.equal(kage('schedule', 'list', '--jq', '.[].id').stdout, '"j1"\n')
})
test('kagelet logs --json gives the kagelet and its runs', () => {
  assert.equal(kage('kagelet', 'add', 'jsontest').status, 0)
  const logs = json('kagelet', 'logs', 'jsontest') as { name: string; runs: unknown[] }
  assert.equal(logs.name, 'jsontest')
  assert.deepEqual(logs.runs, [])
  assert.equal(kage('kagelet', 'logs', '--json', 'jsontest').status, 0)
})
