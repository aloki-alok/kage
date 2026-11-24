import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tellHeldOnce } from '../updates.ts'

test('a held release is DMed once per commit and reason, and again when the DM did not go out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-held-')), dms: string[] = []
  let sent = false
  const o = { dir, notify: async (t: string) => { dms.push(t); return sent } }
  await tellHeldOnce(o, 'aaa1111bbbb', 'kage doctor is not "All good"')
  sent = true
  await tellHeldOnce(o, 'aaa1111bbbb', 'kage doctor is not "All good"')
  await tellHeldOnce(o, 'aaa1111bbbb', 'kage doctor is not "All good"')
  await tellHeldOnce(o, 'aaa1111bbbb', 'an error kind is new since aaa1111bbbb started: hub_job')
  assert.equal(dms.length, 3)
  assert.equal(dms[1], 'Kage did not release aaa1111, which ran 24 hours on this hub: kage doctor is not "All good". It checks again every hour.')
  assert.match(dms[2]!, /hub_job/)
})
