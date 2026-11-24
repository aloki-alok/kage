import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorWatch, runDoctor } from '../doctor-watch.ts'

function setup(outs: string[], sent = true) {
  const saved = new Map<string, unknown>(), dms: string[] = [], events: string[] = []
  const check = doctorWatch({
    run: async () => outs.shift() ?? '',
    store: { load: k => saved.get(k), save: (k, v) => { saved.set(k, v) } },
    say: async t => { dms.push(t); return sent },
    event: d => { events.push(d) },
  })
  return { check, saved, dms, events }
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
