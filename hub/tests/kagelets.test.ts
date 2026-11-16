import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hubKagelets } from '../kagelets.ts'
import { kageletDeliver } from '../../runtime/kagelet-notes.ts'
import { kageletsDir, writeJob } from '../../runtime/kagelet-files.ts'
import { openLedgers, runEvents } from '../../runtime/ledger.ts'
import { openStore } from '../../runtime/store.ts'
import type { Task } from '../../core/task.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const LANE = 'CTEST1:1700000000.123456#side-kagelet-posts'

// ADR 0016's stress run through the hub's own wiring: a fake measure moves the number, and every run reads it.
test('the hub measures an objective on its clock, and each run of the kagelet reads the number, the target and the trend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-obj-'))
  const value = join(dir, 'value')
  const measure = join(dir, 'views.sh')
  writeFileSync(measure, `#!/bin/sh\necho "value: $(cat ${value})"\n`, { mode: 0o755 })
  writeFileSync(value, '320')
  writeJob(kageletsDir(dir), 'posts', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\nobjective: Two posts a week over 500 views\nmeasure: ${measure}\ntarget: >= 500\n---\nWrite and post.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: { measureMinutes: 60 }, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent',
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  const runs: string[] = []
  const deliver = kageletDeliver(kag.notes, (_key, t: Task) => { runs.push(t.content); return 'sent' }, kag.board)
  const task = { content: 'Run your job.' } as Task

  await kag.measure(0)
  deliver(LANE, task)
  assert.match(runs[0]!, /^Objective: Two posts a week over 500 views\nNumber: 320 \(target >= 500, not met\)/)
  assert.match(runs[0]!, /Run your job\.$/)

  writeFileSync(value, '640')
  await kag.measure(30 * 60_000)                             // inside the hour: the hub does not measure again
  await kag.measure(61 * 60_000)
  deliver(LANE, task)
  assert.match(runs[1]!, /Number: 640 \(target >= 500, met\)\. Trend, oldest first: 320, 640/)
  assert.match(runs[1]!, /Keep working toward it, met or not/)   // a worker never goes quiet on a met target
  deliver('CTEST1:1700000000.123456', task)
  assert.equal(runs[2], 'Run your job.')                     // the thread's own session reads no scoreboard
  assert.ok(!ledgers.events(new Date(0).toISOString().slice(0, 10)).some(e => /320|640/.test(JSON.stringify(e))), 'the value reached the event log')
})
