import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dreams } from '../dreams.ts'
import { openStore } from '../../runtime/store.ts'
import { DREAM_LIMITS } from '../../core/dream.ts'
import { writeJob } from '../../runtime/kagelets/files.ts'

test("the dream's lessons are read from tonight's thread transcripts, and the nightly cap holds across calls (#488)", () => {
  const root = mkdtempSync(join(tmpdir(), 'kage-dreams-')), project = join(root, 'proj'), own = join(root, 'own')
  mkdirSync(project); mkdirSync(own)
  const store = openStore(':memory:')
  const said = (t: string) => JSON.stringify({ type: 'user', message: { content: t } })
  writeFileSync(join(project, 's1.jsonl'), `${said('please never squash-merge Kage PRs, and keep commits small please')}\n`)
  writeFileSync(join(project, 's2.jsonl'), `${said('no squash merges on this repo, and keep commits small please')}\n`)
  store.saveSessions({ 'CTEST1:1.1': 's1', 'CTEST2:2.2': 's2', 'CTEST3:3.3': 's1' })
  store.save('dream-threads', ['CTEST1:1.1', 'CTEST2:2.2'])
  const d = dreams({ dir: root, code: root, title: 'Kage', botDm: 'DTEST', mem: { own, owner: join(root, 'owner') }, project, kagelets: join(root, 'k'), kmem: {} as never, hasSdk: true,
    store, ledgers: { events: () => [], text: () => '' } as never, placeOf: k => k, paused: () => false, quiet: () => true,
    deliver: () => 'sent', toSession: () => 'sent', limits: () => ({ ...DREAM_LIMITS, maxNew: 1 }) })
  const ev = (a: string, b: string) => [{ key: 'CTEST1:1.1', quote: a }, { key: 'CTEST2:2.2', quote: b }]
  assert.match(d.lessons([{ kind: 'new', file: 'merge.md', text: 'Merge commits, never squash.', confidence: 0.9, evidence: ev('never squash-merge Kage PRs', 'no squash merges on this repo') }]), /^kept 1: merge\.md/)
  assert.match(d.lessons([{ kind: 'new', file: 'small.md', text: 'Keep commits small.', confidence: 0.9, evidence: ev('keep commits small please', 'keep commits small please') }]), /dropped 1: small\.md \(over 0 new lessons tonight\)/)
  assert.match(d.lessons([{ kind: 'new', file: 'x.md', text: 'x', confidence: 0.9, evidence: [{ key: 'CTEST1:1.1', quote: 'keep commits small please' }, { key: 'CTEST3:3.3', quote: 'keep commits small please' }] }]), /CTEST3:3\.3 is not a thread of this dream/)
  assert.equal(readFileSync(join(own, 'merge.md'), 'utf8'), 'Merge commits, never squash.\n')
})

test("the dream's task lists the files in both memory folders, read by the hub at the start (#563)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'kage-dreams-')), own = join(root, 'own'), owner = join(root, 'owner')
  mkdirSync(own); mkdirSync(owner)
  writeFileSync(join(own, 'kage-note.md'), 'a')
  writeFileSync(join(owner, 'owner-note.md'), 'b')
  const sent: string[] = []
  const d = dreams({ dir: root, code: root, title: 'Kage', botDm: 'DTEST', mem: { own, owner }, project: join(root, 'proj'), kagelets: join(root, 'k'), kmem: {} as never, hasSdk: true,
    store: openStore(':memory:'), ledgers: { events: () => [], text: () => '' } as never, placeOf: k => k, paused: () => false, quiet: () => true,
    deliver: (_c, task) => { sent.push(task.content); return 'sent' }, toSession: () => 'sent', limits: () => DREAM_LIMITS })
  await d.dream(new Date(2026, 10, 4, 3, 0).getTime())
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /kage-note\.md 1 KB/)
  assert.match(sent[0]!, /owner-note\.md 1 KB/)
})

const NIGHT = new Date(2026, 10, 4, 3, 0).getTime()
type Opts = Parameters<typeof dreams>[0]
function night(o: Partial<Opts> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kage-dreams-')), own = join(root, 'own'), owner = join(root, 'owner'), kagelets = join(root, 'k')
  mkdirSync(own); mkdirSync(owner)
  const store = openStore(':memory:')
  const sent: string[] = []
  let result = 'sent'
  const base: Opts = { dir: root, code: root, title: 'Kage', botDm: 'DTEST', mem: { own, owner }, project: join(root, 'proj'), kagelets, kmem: { notes: () => [] } as never, hasSdk: true,
    store, ledgers: { events: () => [], text: () => '' } as never, placeOf: k => k, paused: () => false, quiet: () => true,
    deliver: (_c, task) => { sent.push(task.content); return result }, toSession: (key, _t) => { sent.push(key); return result }, limits: () => DREAM_LIMITS }
  return { root, store, sent, kagelets, d: (x: Partial<Opts> = {}) => dreams({ ...base, ...o, ...x }), fail: (r: string) => { result = r } }
}

test('a dream runs only when not paused, and the night counts as dreamt only once the task was delivered', async () => {
  const n = night()
  await n.d({ paused: () => true }).dream(NIGHT)
  assert.deepEqual(n.sent, [])
  n.store.save('dream-kept', { new: 3, outdated: 1 })
  mkdirSync(join(n.root, 'proj'))
  writeFileSync(join(n.root, 'proj', 's1.jsonl'), 'x\n')
  n.store.saveSessions({ 'CTEST1:1.1': 's1' })
  n.fail('failed')
  await n.d().dream(NIGHT)
  assert.equal(n.sent.length, 1)
  assert.deepEqual(n.store.load('dream-kept'), { new: 0, outdated: 0 })
  assert.deepEqual(n.store.load('dream-threads'), ['CTEST1:1.1'])
  n.fail('sent')
  await n.d().dream(NIGHT + 60_000)
  assert.equal(n.sent.length, 2)
  await n.d().dream(NIGHT + 120_000)
  assert.equal(n.sent.length, 2)
})

test('kagelet dreams start one at a time in their dream lane, need the Agent SDK, and count only once delivered', () => {
  const job = (ts: string) => `---\nthread: https://test.slack.com/archives/CTEST1/p${ts}\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\n---\nWork.\n`
  const runs = `${new Date(NIGHT - 3600_000).toISOString()}\tkagelet-a\n${new Date(NIGHT - 3600_000).toISOString()}\tkagelet-b\n`
  const n = night({ ledgers: { events: () => [], text: (name: string) => name === 'runs' ? runs : '' } as never })
  for (const [name, ts] of [['a', '1700000000123456'], ['b', '1700000000654321']] as const) {
    writeJob(n.kagelets, name, job(ts))
    n.store.seen(`CTEST1:${ts.slice(0, 10)}.${ts.slice(10)}#side-kagelet-${name}`, { connector: 'slack', chat: 'CTEST1', thread: `${ts.slice(0, 10)}.${ts.slice(10)}`, kind: 'channel' }, name, 0)
  }
  n.d({ hasSdk: false }).kageletDreams(NIGHT)
  n.d({ paused: () => true }).kageletDreams(NIGHT)
  assert.deepEqual(n.sent, [])
  n.fail('failed')
  n.d().kageletDreams(NIGHT)
  assert.deepEqual(n.sent, ['CTEST1:1700000000.123456#side-kdream-a'])
  n.fail('sent')
  n.d().kageletDreams(NIGHT)
  n.d().kageletDreams(NIGHT)
  assert.deepEqual(n.sent, ['CTEST1:1700000000.123456#side-kdream-a', 'CTEST1:1700000000.123456#side-kdream-a', 'CTEST1:1700000000.654321#side-kdream-b'])
  n.d().kageletDreams(NIGHT)
  assert.equal(n.sent.length, 3)
})

test('a kagelet with no conversation yet is skipped, and the next one due dreams', () => {
  const runs = `${new Date(NIGHT - 3600_000).toISOString()}\tkagelet-a\n${new Date(NIGHT - 3600_000).toISOString()}\tkagelet-b\n`
  const n = night({ ledgers: { events: () => [], text: (name: string) => name === 'runs' ? runs : '' } as never })
  writeJob(n.kagelets, 'a', `---\nthread: https://test.slack.com/archives/CTEST1/p1700000000123456\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\n---\nWork.\n`)
  writeJob(n.kagelets, 'b', `---\nthread: https://test.slack.com/archives/CTEST1/p1700000000654321\nschedule: 0 9 * * *\ntools: WebSearch\nby: owner\n---\nWork.\n`)
  n.store.seen('CTEST1:1700000000.654321#side-kagelet-b', { connector: 'slack', chat: 'CTEST1', thread: '1700000000.654321', kind: 'channel' }, 'b', 0)
  n.d().kageletDreams(NIGHT)
  assert.deepEqual(n.sent, ['CTEST1:1700000000.654321#side-kdream-b'])
})

test('a flagged lesson closes its flag as fixed or merged, a dismissal closes it with the reason, and an unknown id changes nothing (#541)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kage-dreams-')), project = join(root, 'proj'), own = join(root, 'own')
  mkdirSync(project); mkdirSync(own)
  writeFileSync(join(own, 'deploy.md'), 'Deploy with scripts/deploy.sh.\n')
  writeFileSync(join(project, 's1.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'ship the hotfix please' } })}\n`)
  const store = openStore(':memory:')
  store.saveSessions({ 'CTEST1:1.1': 's1' })
  const rows = [['f1', 'open', 'CTEST1:1.1', 'wrong', 'deploy.md', 'the deploy script moved to bin/ship', ''], ['f2', 'open', 'CTEST1:1.1', 'missing', 'key rotation', 'no note says how to rotate the key', ''], ['f3', 'open', 'CTEST1:1.1', 'stale', 'ports.md', 'the hub port is 3199 now', '']]
  const added: string[][] = []
  const ledgers = { events: () => [], text: (name: string) => name === 'flags' ? rows.map(r => ['2026-11-24T00:00:00.000Z', ...r].join('\t')).join('\n') : '', add: (name: string, cells: string[]) => { added.push([name, ...cells]) } }
  const d = dreams({ dir: root, code: root, title: 'Kage', botDm: 'DTEST', mem: { own, owner: join(root, 'owner') }, project, kagelets: join(root, 'k'), kmem: {} as never, hasSdk: true,
    store, ledgers: ledgers as never, placeOf: k => k, paused: () => false, quiet: () => true, deliver: () => 'sent', toSession: () => 'sent', limits: () => DREAM_LIMITS })
  const said = d.lessons([
    { kind: 'outdated', file: 'deploy.md', text: 'The deploy script is bin/ship now.', confidence: 0.9, flag: 'f1', evidence: [{ key: 'CTEST1:1.1', quote: 'the deploy script moved to bin/ship' }] },
    { kind: 'new', file: 'hub-port.md', text: 'The hub listens on 3199.', confidence: 0.9, flag: 'f3', evidence: [{ key: 'CTEST1:1.1', quote: 'the hub port is 3199 now' }] },
  ], [{ flag: 'f2', reason: 'the key rotation note exists as keys.md' }, { flag: 'f9', reason: 'x' }])
  assert.match(said, /^kept 2/)
  assert.match(said, /f9 is not open/)
  assert.deepEqual(added, [['flags', 'f1', 'fixed', 'deploy.md'], ['flags', 'f3', 'merged', 'hub-port.md'], ['flags', 'f2', 'dismissed', 'the key rotation note exists as keys.md']])
})

test("the dream's task lists the open flags from the ledger (#541)", async () => {
  const n = night({ ledgers: { events: () => [], text: (name: string) => name === 'flags' ? '2026-11-24T00:00:00.000Z\tf1\topen\tCTEST1:1.1\twrong\tdeploy.md\tthe deploy script moved\t' : '' } as never })
  await n.d().dream(NIGHT)
  assert.match(n.sent[0]!, /f1 wrong deploy\.md \(key CTEST1:1\.1\)/)
})
