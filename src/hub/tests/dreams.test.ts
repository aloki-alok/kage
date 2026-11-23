import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dreams } from '../dreams.ts'
import { openStore } from '../../runtime/store.ts'
import { DREAM_LIMITS } from '../../core/dream.ts'

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
