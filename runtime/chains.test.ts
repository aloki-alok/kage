// Chains and kagelet messages end to end (#93) on a fake hub: the real store, scheduler, manager, ledgers and
// event log, with a fake runner that records each task. The test plays each kagelet: it reports, then its turn ends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openStore } from './store.ts'
import { openLedgers, runEvents } from './ledger.ts'
import { scheduler } from './scheduler.ts'
import { kageletManager, kageletRoutes, readKagelets, syncKagelets } from './kagelets.ts'
import { chainLine, chainViews } from '../core/events.ts'
import type { Task } from './protocol.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const keyOf = (name: string) => `CTEST1:1700000000.123456#side-kagelet-${name}`
const NINE = new Date(2026, 10, 14, 9, 0).getTime()

function hub(o: { chainUsd?: number; capUsd?: number } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/kage-chains-`)
  const kagelets = `${dir}/kagelets`, work = `${dir}/files`
  mkdirSync(work)
  let n = 0
  const store = openStore(':memory:')
  const ledgers = openLedgers(dir, () => new Date(NINE + n * 1000).toISOString())
  const runs = runEvents(ledgers, () => `t${++n}`)
  const tasks: [string, Task][] = []
  // The hub's toSession, as far as runs go: every delivered task opens a run, on its chain.
  const deliver = (key: string, task: Task) => {
    tasks.push([key, task])
    runs.start(key, task.scheduled ? `scheduled ${task.job}` : 'task', { fresh: !!task.scheduled, ...(task.chain && { chain: task.chain }) })
    return 'starting' as const
  }
  const sync = (now: number) => syncKagelets(readKagelets(kagelets), store, now, () => {})
  const schedules = scheduler({ store, deliver, failed: () => {}, ready: () => 'ready', trusted: () => false, ran: j => ledgers.add('runs', [j.id, j.key]) })
  const manager = kageletManager({ dir: kagelets, max: 10, ledgers, sync, runNow: (id, now) => schedules.runNow(id, now), store, log: () => {} })
  const routes = kageletRoutes({ dir: kagelets, workDir: work, store, ledgers, runs, deliver, capUsd: o.capUsd ?? 2, chainUsd: o.chainUsd ?? 5, log: () => {} })
  // One kagelet's turn: what the report tool does, then the runner's turn end with its cost.
  const step = (name: string, r: { output?: string; needs?: string; report?: false; usd?: number } = {}) => {
    if (r.report !== false) { runs.emit(keyOf(name), 'report', r.needs ? 'needs' : 'ok'); routes.reported(keyOf(name), { needs: r.needs ?? '', output: r.output ?? '' }) }
    routes.ended(keyOf(name), r.usd ?? 0.1, `/t/${name}.jsonl`, NINE + 60_000)
  }
  const save = (name: string, f: { schedule?: string; after?: string }) =>
    manager.manage({ action: 'save', name, thread: LINK, schedule: f.schedule ?? '', ...(f.after && { after: f.after }), tools: ['WebFetch'], job: `Job of ${name}.`, by: 'owner', why: 'w' }, NINE - 60_000)
  const chains = () => chainViews(ledgers.events('2026-11-14')).map(chainLine)
  return { store, ledgers, runs, tasks, schedules, routes, step, save, chains, work, manager }
}

async function abc(o?: { chainUsd?: number }) {
  const h = hub(o)
  assert.match(await h.save('a', { schedule: '0 9 * * *' }), /saved a/)
  assert.match(await h.save('b', { after: 'a' }), /saved b/)
  assert.match(await h.save('c', { after: 'b' }), /saved c/)
  assert.deepEqual(h.store.schedules().map(s => s.id), ['kagelet-a'])   // b and c run only after another
  h.schedules.tick(NINE)
  assert.deepEqual(h.tasks.map(([k]) => k), [keyOf('a')])
  return h
}

test('a > b > c: each output starts the next run as its input, with no Kage turn, and the events show the chain', async () => {
  const h = await abc()
  h.step('a', { output: 'https://example.com/video-1' })
  assert.deepEqual(h.tasks.map(([k]) => k), [keyOf('a'), keyOf('b')])
  const [, b] = h.tasks[1]!
  assert.match(b.content, /Job of b\.[\s\S]*Input from kagelet a[\s\S]*https:\/\/example\.com\/video-1/)
  assert.equal(b.fromOwner, false)
  assert.equal(b.chain, 't1')                       // the chain is named after the run that started it
  assert.deepEqual(h.chains(), ['a > b  running'])
  h.step('b', { output: 'trimmed: https://example.com/video-1-cut' })
  assert.match(h.tasks[2]![1].content, /Input from kagelet b[\s\S]*video-1-cut/)
  h.step('c', { output: 'uploaded' })
  assert.equal(h.tasks.length, 3)                   // c has no kagelet after it
  assert.deepEqual(h.chains(), ['a > b > c  done'])
  // Kage's kagelets tool shows one line per chain today.
  assert.match(h.manager.list(NINE), /Chains today:\n  a > b > c  done/)
  const handoffs = h.ledgers.events('2026-11-14').filter(e => e.kind === 'handoff').map(e => [e.who, e.chain, e.detail])
  assert.deepEqual(handoffs, [['a', 't1', 'to b, link: ok'], ['b', 't1', 'to c, note: ok']])
  // Every run of the chain is on it, the first one too.
  assert.deepEqual(h.ledgers.events('2026-11-14').filter(e => e.kind === 'run.end').map(e => [e.who, e.chain]), [['a', 't1'], ['b', 't1'], ['c', 't1']])
})

test('a step that ends without a report stops the chain before the next one, and Kage gets it with the chain id', async () => {
  const h = await abc()
  h.step('a', { output: 'https://example.com/v' })
  h.step('b', { report: false })
  assert.equal(h.tasks.length, 2)                   // c never ran
  assert.deepEqual(h.chains(), ['a > b  stopped at b: ended without a report'])
  assert.match(h.ledgers.text('waiting'), /\topen\t.*chain t1 stopped at b: ended without a report/)
})

test('a step that needs something, or had a call refused, stops the chain too', async () => {
  const h = await abc()
  h.step('a', { output: 'https://example.com/v' })
  h.step('b', { output: 'x', needs: 'approval to upload' })
  assert.deepEqual(h.chains(), ['a > b  stopped at b: needs approval to upload'])
  const r = await abc()
  r.step('a', { output: 'https://example.com/v' })
  r.runs.emit(keyOf('b'), 'refusal', 'Bash: not granted')
  r.step('b', { output: 'x' })
  assert.deepEqual(r.chains(), ['a > b  stopped at b: a tool call was refused, so it needs approval'])
  assert.equal(r.tasks.length, 2)
})

test('a run with no output ends the chain quietly; no output, no handoff', async () => {
  const h = await abc()
  h.step('a')
  assert.equal(h.tasks.length, 1)
  assert.deepEqual(h.chains(), [])
})

test('the cost cap per chain stops it before the next step', async () => {
  const h = await abc({ chainUsd: 0.15 })
  h.step('a', { output: 'https://example.com/v', usd: 0.1 })
  h.step('b', { output: 'x', usd: 0.1 })
  assert.equal(h.tasks.length, 2)
  assert.deepEqual(h.chains(), ['a > b > c  stopped before c: the chain spent $0.20, at or over its cap of $0.15 (KAGE_KAGELET_CHAIN_USD)'])
  // Each kagelet's own daily cap still holds: b spent $2 today, so a's next output does not start it.
  const k = await abc()
  k.ledgers.add('costs', [keyOf('b'), '2', '2'])
  k.step('a', { output: 'https://example.com/v' })
  assert.equal(k.tasks.length, 1)
  assert.match(k.chains()[0]!, /stopped before b: b spent \$2\.00 today, at or over its daily cap/)
})

test('save refuses an after that names no kagelet, makes a cycle, or goes deeper than 5', async () => {
  const h = hub()
  assert.match(await h.save('b', { after: 'gone' }), /not saved: after names no kagelet named "gone"/)
  await h.save('a', { schedule: '0 9 * * *' })
  await h.save('b', { after: 'a' })
  assert.match(await h.save('a', { after: 'b' }), /not saved: after makes a cycle/)
  for (const [x, y] of [['c', 'b'], ['d', 'c'], ['e', 'd']]) await h.save(x!, { after: y })
  assert.match(await h.save('f', { after: 'e' }), /not saved: this chain is 6 steps deep/)
})

test('a kagelet messages another: it wakes its next run with the text; the loop guard stops a ping-pong at 4 hops', async () => {
  const h = hub()
  await h.save('a', { schedule: '0 9 * * *' })
  await h.save('b', { schedule: '0 10 * * *' })
  h.schedules.tick(NINE)
  assert.equal(h.routes.message(keyOf('a'), 'b', 'Can you check video-1?'), 'sent to b')
  assert.match(h.tasks[1]![1].content, /Job of b\.[\s\S]*Message from kagelet a[\s\S]*Can you check video-1\?/)
  const chain = h.tasks[1]![1].chain
  assert.equal(chain, 't1')
  // b answers, a answers, b answers: hops 2, 3, 4. The fifth is refused.
  assert.equal(h.routes.message(keyOf('b'), 'a', 'checked'), 'sent to a')
  assert.equal(h.routes.message(keyOf('a'), 'b', 'thanks'), 'sent to b')
  assert.equal(h.routes.message(keyOf('b'), 'a', 'welcome'), 'sent to a')
  assert.match(h.routes.message(keyOf('a'), 'b', 'bye'), /not sent: .*4 hops/)
  assert.equal(h.tasks.length, 5)
  assert.deepEqual(h.chains(), ['a > b > a > b > a > b  stopped before b: 4 hops with no person or schedule in between (the limit is 4)'])
  // A new run from the schedule is new input: a fresh chain.
  h.step('a')
  h.schedules.tick(NINE + 24 * 3600_000)
  assert.equal(h.routes.message(keyOf('a'), 'b', 'new day'), 'sent to b')
})

test('a message goes only to another kagelet of this install, with a file only from the work folder', async () => {
  const h = hub()
  await h.save('a', { schedule: '0 9 * * *' })
  h.schedules.tick(NINE)
  assert.match(h.routes.message(keyOf('a'), 'zed', 'hi'), /not sent: there is no kagelet named "zed"/)
  assert.match(h.routes.message(keyOf('a'), 'a', 'hi'), /not sent: .*itself/)
  await h.save('b', { schedule: '0 10 * * *' })
  assert.match(h.routes.message(keyOf('a'), 'b', 'hi', '/etc/passwd'), /not sent: .*work folder/)
  assert.match(h.routes.message(keyOf('a'), 'b', 'hi', `${h.work}/../kagelets/a.md`), /not sent: .*work folder/)
  assert.equal(h.routes.message(keyOf('a'), 'b', 'the cut', `${h.work}/cut.mp4`), 'sent to b')
  assert.match(h.tasks.at(-1)![1].content, /File: .*cut\.mp4/)
  assert.match(h.ledgers.events('2026-11-14').filter(e => e.kind === 'handoff').at(-1)!.detail, /^to b, file: ok$/)
})
