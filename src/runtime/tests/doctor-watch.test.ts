import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorWatch, runDoctor } from '../doctor-watch.ts'

function setup(outs: string[], sent = true, o: { fileOk?: () => boolean; canFile?: boolean; clock?: { t: number } } = {}) {
  const saved = new Map<string, unknown>(), dms: string[] = [], events: string[] = [], filed: string[] = []
  const clock = o.clock ?? { t: 0 }
  const check = doctorWatch({
    file: async r => { if (o.fileOk && !o.fileOk()) throw new Error('gh down'); filed.push(r.title) },
    canFile: async () => o.canFile ?? true,
    now: () => clock.t,
    run: async () => outs.shift() ?? '',
    store: { load: k => saved.get(k), save: (k, v) => { saved.set(k, v) } },
    say: async t => { dms.push(t); return sent },
    event: d => { events.push(d) },
  })
  return { check, saved, dms, events, filed }
}

test('the hourly doctor DMs a failure seen twice once, stays quiet while it lasts, and says when it clears, one event per run (#153)', async () => {
  const fail = 'FAIL  token file: run chmod 600 x'
  const t = setup([fail, fail, fail, 'ok    all fine'])
  await t.check(); await t.check(); await t.check(); await t.check()
  assert.equal(t.dms.length, 2)
  assert.match(t.dms[0]!, /token file: run chmod 600 x/)
  assert.match(t.dms[1]!, /all good again/)
  assert.deepEqual(t.events, ['doctor failing=1 told=0', 'doctor failing=1 told=1', 'doctor failing=1 told=1', 'doctor failing=0 told=0'])
})

test('a DM that did not go out is tried again on the next run', async () => {
  const t = setup(['FAIL  a', 'FAIL  a', 'FAIL  a'], false)
  await t.check(); await t.check(); await t.check()
  assert.equal(t.dms.length, 2)
  assert.deepEqual(t.saved.get('doctor-told'), [])
})

test('a doctor that runs past its time limit is a failure, not an all good', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-dr-'))
  writeFileSync(join(dir, 'setup.sh'), '#!/bin/sh\necho "ok    tools"\nexec sleep 5\n')
  chmodSync(join(dir, 'setup.sh'), 0o755)
  const out = await runDoctor(dir, 300)()
  assert.match(out, /^ok    tools$/m)
  assert.match(out, /^FAIL  the doctor took over 0\.3 s, so some checks did not finish$/m)
})

test('a check that keeps failing to run is filed once as a bug, and a known fix line never is (#153)', async () => {
  const out = 'FAIL  slack: the check did not run (boom)\nFAIL  token file: run chmod 600 x'
  const t = setup([out, out, out])
  await t.check(); await t.check(); await t.check()
  assert.deepEqual(t.filed, ['kage doctor: the slack check did not run'])
})

const threw = 'FAIL  slack: the check did not run (boom)'

test('a filing that failed is tried again on the next run', async () => {
  let ok = false
  const t = setup([threw, threw, threw], true, { fileOk: () => ok })
  await t.check(); await t.check()
  assert.deepEqual(t.filed, [])
  assert.ok(t.events.includes('doctor file failed'))
  ok = true
  await t.check()
  assert.deepEqual(t.filed, ['kage doctor: the slack check did not run'])
})

test('a check that flips files at most once a day', async () => {
  const clock = { t: 0 }, ok = 'ok    fine'
  const t = setup([threw, threw, ok, threw, threw, threw, threw], true, { clock })
  for (let i = 0; i < 5; i++) await t.check()
  assert.equal(t.filed.length, 1)
  clock.t = 86_400_000
  await t.check()
  assert.equal(t.filed.length, 2)
})

test('a hub that cannot push to the Kage repo files nothing', async () => {
  const t = setup([threw, threw], true, { canFile: false })
  await t.check(); await t.check()
  assert.deepEqual(t.filed, [])
})

test('each fix the doctor applied is one event (#153)', async () => {
  const t = setup(['fixed token file: run chmod 600 /k/s\nok    tools', 'ok    tools'])
  await t.check(); await t.check()
  assert.deepEqual(t.events, ['doctor fixed: token file: run chmod 600 /k/s', 'doctor failing=0 told=0', 'doctor failing=0 told=0'])
})
