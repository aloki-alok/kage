import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doctorWatch } from '../doctor-watch.ts'

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

test('the hourly doctor DMs a new failure once, stays quiet while it lasts, and says when it clears, one event per run (#153)', async () => {
  const t = setup(['FAIL  token file: run chmod 600 x', 'FAIL  token file: run chmod 600 x', 'ok    all fine'])
  await t.check(); await t.check(); await t.check()
  assert.equal(t.dms.length, 2)
  assert.match(t.dms[0]!, /token file: run chmod 600 x/)
  assert.match(t.dms[1]!, /all good again/)
  assert.deepEqual(t.events, ['doctor failing=1', 'doctor failing=1', 'doctor failing=0'])
})

test('a DM that did not go out is tried again on the next run', async () => {
  const t = setup(['FAIL  a', 'FAIL  a'], false)
  await t.check(); await t.check()
  assert.equal(t.dms.length, 2)
  assert.equal(t.saved.get('doctor-told'), undefined)
})
