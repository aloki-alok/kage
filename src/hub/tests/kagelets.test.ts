import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hubKagelets } from '../kagelets.ts'
import { kageletDeliver } from '../../runtime/kagelets/notes.ts'
import { kageletsDir, writeJob } from '../../runtime/kagelets/files.ts'
import { openLedgers, runEvents } from '../../runtime/ledger.ts'
import { openStore } from '../../runtime/store.ts'
import type { Task } from '../../core/task.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const LANE = 'CTEST1:1700000000.123456#side-kagelet-posts'

test('the hub measures an objective on its clock, and each run of the kagelet reads the number, the target and the trend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-obj-'))
  const value = join(dir, 'value')
  const measure = join(dir, 'views.sh')
  writeFileSync(measure, `#!/bin/sh\necho "value: $(cat ${value})"\n`, { mode: 0o755 })
  writeFileSync(value, '320')
  writeJob(kageletsDir(dir), 'posts', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\nobjective: Two posts a week over 500 views\nmeasure: ${measure}\ntarget: >= 500\n---\nWrite and post.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: { measureMinutes: 60 }, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  const runs: string[] = []
  const deliver = kageletDeliver(kag.notes, (_key, t: Task) => { runs.push(t.content); return 'sent' }, kag.board)
  const task = { content: 'Run your job.' } as Task

  await kag.measure(0)
  deliver(LANE, task)
  assert.match(runs[0]!, /^Objective: Two posts a week over 500 views\nNumber: 320 \(target >= 500, not met\)/)
  assert.match(runs[0]!, /Run your job\.$/)

  writeFileSync(value, '640')
  await kag.measure(30 * 60_000)
  await kag.measure(61 * 60_000)
  deliver(LANE, task)
  assert.match(runs[1]!, /Number: 640 \(target >= 500, met\)\. Trend, oldest first: 320, 640/)
  assert.match(runs[1]!, /Keep working toward it, met or not/)
  deliver('CTEST1:1700000000.123456', task)
  assert.equal(runs[2], 'Run your job.')
  assert.ok(!ledgers.events(new Date(0).toISOString().slice(0, 10)).some(e => /320|640/.test(JSON.stringify(e))), 'the value reached the event log')
})

test('the owner\'s always on a held step\'s card writes one allow line into that kagelet\'s job.md, and nothing for another tool or lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-always-'))
  writeJob(kageletsDir(dir), 'posts', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: all\nby: owner\n---\nDeploy staging.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: {}, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  const job = () => readFileSync(join(kageletsDir(dir), 'posts', 'job.md'), 'utf8')
  kag.alwaysAllow(LANE, 'mcp__x__y', { command: 'kubectl apply -f staging/web.yaml' })
  kag.alwaysAllow('CTEST1:1700000000.123456', 'Bash', { command: 'kubectl apply -f staging/web.yaml' })
  assert.doesNotMatch(job(), /allow:/)
  kag.alwaysAllow(LANE, 'Bash', { command: 'kubectl apply -f staging/web.yaml' })
  assert.match(job(), /^allow: kubectl apply -f staging\/web\.yaml$/m)
  assert.deepEqual(ledgers.events(new Date().toISOString().slice(0, 10)).filter(e => e.kind === 'held').map(e => e.detail), ['always allowed by the owner: a deploy'])
  kag.alwaysAllow(LANE, 'Bash', { command: 'kubectl apply -f staging/web.yaml' })
  assert.equal(job().match(/^allow:/gm)!.length, 1)
})

test('a people ask to a kagelet that runs only after another says when it reads the ask, and claims no run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-ask-'))
  writeJob(kageletsDir(dir), 'a', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\n---\nGather.\n`)
  writeJob(kageletsDir(dir), 'b', `---\nthread: ${LINK}\nafter: a\ntools: WebSearch\nby: owner\npeople: UTEST1\n---\nSummarize.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: {}, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  kag.sync(Date.now())
  assert.equal(kag.ask('CTEST1', '1700000000.123456', 'b', 'UTEST1', 'add the totals'), 'Noted for b. It runs after a, and reads this then.')
})

test('a kagelet owner may ask it for work in its thread, like a person on its people line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-own-'))
  writeJob(kageletsDir(dir), 'b', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\nowners: UTEST2\n---\nSummarize.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: {}, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  kag.sync(Date.now())
  assert.deepEqual(kag.peopleIn('CTEST1', '1700000000.123456'), [{ name: 'b', people: ['UTEST2'] }])
})

test('a sync grants each runnable kagelet its lane, model, allow lines and budget, and without the Agent SDK it grants none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-sync-'))
  writeJob(kageletsDir(dir), 'posts', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\nmodel: opus\nallow: git status\n---\nPost.\n`)
  const ledgers = openLedgers(dir)
  let sdk = true
  const kag = hubKagelets({ dir, kl: { dailyUsd: 2 }, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => sdk, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  assert.equal(await kag.tell('posts', 'hi', false), 'no kagelet named "posts" runs here')
  kag.sync(Date.now())
  assert.deepEqual([...kag.lanes()], [LANE])
  assert.deepEqual(kag.grantOf(LANE), ['WebSearch'])
  assert.equal(kag.modelOf(LANE), 'opus')
  assert.deepEqual(kag.allowOf(LANE), ['git status'])
  assert.equal(kag.budgetOf(LANE), 2)
  assert.equal(kag.budgetOf('CTEST1:1700000000.123456'), undefined)
  assert.deepEqual(kag.grantOf('CTEST1:1.2#side-kagelet-gone'), [])
  assert.equal(kag.grantOf('CTEST1:1.2'), undefined)
  assert.equal(await kag.tell('posts', 'hi', false), 'told posts: its next run reads it')
  sdk = false
  kag.sync(Date.now())
  assert.deepEqual([...kag.lanes()], [])
  assert.equal(kag.modelOf(LANE), undefined)
  assert.deepEqual(kag.allowOf(LANE), [])
})

test('a kagelet past kagelets.max gets no lane, model or allow lines, and one over its daily cap pauses with a report and a waiting row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-hub-cap-'))
  const LINK2 = 'https://test.slack.com/archives/CTEST2/p1700000000123456', LANE2 = 'CTEST2:1700000000.123456#side-kagelet-zz'
  writeJob(kageletsDir(dir), 'posts', `---\nthread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\n---\nPost.\n`)
  writeJob(kageletsDir(dir), 'zz', `---\nthread: ${LINK2}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\nmodel: opus\nallow: git status\n---\nMore.\n`)
  const ledgers = openLedgers(dir)
  const kag = hubKagelets({ dir, kl: { max: 1, dailyUsd: 1 }, mem: { own: join(dir, 'm1'), owner: join(dir, 'm2') }, store: openStore(':memory:'), ledgers,
    runs: runEvents(ledgers, () => 't1'), title: 'Kage', notify: () => {}, hasSdk: () => true, runNow: () => undefined, toSession: () => 'sent', lanes: { busy: () => false, last: () => 0, cut: () => {} },
    idle: () => true, paused: () => undefined, tripwires: () => ({}) })
  kag.sync(Date.now())
  assert.deepEqual([...kag.lanes()], [LANE])
  assert.equal(kag.modelOf(LANE2), undefined)
  assert.deepEqual(kag.allowOf(LANE2), [])
  ledgers.add('costs', [LANE, '3', '3'])
  kag.sync(Date.now())
  assert.match(ledgers.text('reports'), /^\S+\tposts\t.*daily cap.*\tthe owner to resume it, or a higher cap$/m)
  assert.match(ledgers.text('waiting'), /\topen\tCTEST1:1700000000\.123456\t.*\tkagelet posts .*daily cap/)
})
