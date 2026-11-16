import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kageletMeasures } from '../kagelet-measures.ts'
import { openStore } from '../store.ts'

const target = { op: '>=' as const, n: 500 }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kage-measure-'))
  const store = openStore(':memory:')
  const events: string[] = []
  const m = kageletMeasures({ store, settings: () => ({ measureMinutes: 60, trendRuns: 3 }), tripwires: () => ({}), event: (who, detail) => events.push(`${who} ${detail}`) })
  const script = (out: string) => { const f = join(dir, `m${Math.random()}.sh`); writeFileSync(f, `#!/bin/sh\n${out}\n`, { mode: 0o755 }); return f }
  return { dir, store, m, events, script }
}
const kagelet = (measure: string, by: 'owner' | 'kage' = 'owner') => ({ name: 'fude', by, paused: false, objective: { objective: 'Posts over 500 views', measure, target } })

test('the hub measures with no model on its clock; the run reads the number and the trend, and the event log never holds the value', async () => {
  const t = setup()
  const cmd = t.script('echo "value: 320"')
  await t.m.tick([kagelet(cmd)], 0)
  await t.m.tick([kagelet(cmd)], 30 * 60_000)                    // inside the hour: no new measure
  assert.equal(t.m.readings('fude').length, 1)
  await t.m.tick([kagelet(cmd)], 61 * 60_000)
  assert.deepEqual(t.m.readings('fude').map(r => r.value), [320, 320])
  assert.match(t.m.board('fude', kagelet(cmd).objective)!, /320 \(target >= 500, not met\)/)
  assert.deepEqual(t.events, ['fude measure working', 'fude measure working'])
  assert.ok(t.events.every(e => !e.includes('320')))
})

test('only the last trendRuns readings are kept', async () => {
  const t = setup()
  const value = join(t.dir, 'value'), cmd = t.script(`echo "value: $(cat ${value})"`)
  for (let i = 0; i < 5; i++) { writeFileSync(value, String(i)); await t.m.tick([kagelet(cmd)], i * 61 * 60_000) }
  assert.deepEqual(t.m.readings('fude').map(r => r.value), [2, 3, 4])
})

test('output that is not exactly one value line is a failed measure, never a guessed number', async () => {
  const t = setup()
  await t.m.tick([kagelet(t.script('echo "about 3 errors"'))], 0)
  assert.equal(t.m.readings('fude')[0]!.value, undefined)
  assert.match(t.m.readings('fude')[0]!.failed!, /value/)
  assert.deepEqual(t.events, ['fude measure failed'])
})

test('a measure Kage wrote runs only after the owner said yes to that exact command; a changed script is refused', async () => {
  const t = setup()
  const cmd = t.script('echo "value: 7"')
  await t.m.tick([kagelet(cmd, 'kage')], 0)
  assert.match(t.m.readings('fude')[0]!.failed!, /owner has not approved/)
  assert.equal(t.m.approve('fude', cmd), undefined)
  await t.m.tick([kagelet(cmd, 'kage')], 61 * 60_000)
  assert.equal(t.m.readings('fude').at(-1)!.value, 7)
  await t.m.tick([kagelet(`${cmd} --other`, 'kage')], 122 * 60_000)   // a new command needs a new yes
  assert.match(t.m.readings('fude').at(-1)!.failed!, /owner has not approved/)
  assert.equal(t.m.approved('fude'), cmd)
  writeFileSync(cmd, '#!/bin/sh\necho "value: 9000"\n')               // the approved script changed under the pin
  await t.m.tick([kagelet(cmd, 'kage')], 183 * 60_000)
  assert.match(t.m.readings('fude').at(-1)!.failed!, /changed/)
  assert.equal(t.m.approved('fude'), undefined)                         // so Kage's next save asks the owner again
})

test('a measure in the owner\'s own file runs with no card, pinned too: a kagelet\'s shell cannot swap the script the hub runs', async () => {
  const t = setup()
  const cmd = t.script('echo "value: 7"')
  await t.m.tick([kagelet(cmd)], 0)
  writeFileSync(cmd, '#!/bin/sh\necho "value: 9000"\n')
  await t.m.tick([kagelet(cmd)], 61 * 60_000)
  assert.match(t.m.readings('fude').at(-1)!.failed!, /changed/)
  assert.equal(t.m.approved('fude'), undefined)                         // the owner's yes on a card brings it back
})

test('a new measure starts a new trend, and a removed kagelet leaves no approval or readings behind', async () => {
  const t = setup()
  const a = t.script('echo "value: 7"'), b = t.script('echo "value: 300"')
  await t.m.tick([kagelet(a)], 0)
  await t.m.tick([kagelet(b)], 1)                                         // a new command measures at once
  assert.deepEqual(t.m.readings('fude').map(r => r.value), [300])
  t.m.forget('fude')
  assert.deepEqual(t.m.readings('fude'), [])
  assert.equal(t.m.approved('fude'), undefined)
})

test('an owner\'s command the probe refuses says why, not that it waits on the owner', async () => {
  const t = setup()
  await t.m.tick([kagelet('')], 0)
  assert.equal(t.m.readings('fude')[0]!.failed, 'the probe command is empty')
})

test('a kagelet removed while its measure runs gets no reading back', async () => {
  const t = setup()
  const k = kagelet(t.script('sleep 1\necho "value: 7"'))
  const run = t.m.tick([k], 0)
  await new Promise(r => setTimeout(r, 300))
  t.m.forget('fude')
  await run
  assert.deepEqual(t.m.readings('fude'), [])
})

test('a paused kagelet, or one with no objective, is not measured', async () => {
  const t = setup()
  await t.m.tick([{ ...kagelet(t.script('echo "value: 1"')), paused: true }, { name: 'kane', by: 'owner', paused: false }], 0)
  assert.deepEqual(t.m.readings('fude'), [])
  assert.equal(t.m.board('kane', undefined), undefined)
})
