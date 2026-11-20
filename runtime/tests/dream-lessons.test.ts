import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLessons } from '../dream-lessons.ts'
import { DREAM_LIMITS, type DreamLesson } from '../../core/dream.ts'

const chats = { 'C1:1.1': 'owner: never squash-merge Kage PRs', 'C2:2.2': 'owner: no squash merges on this repo', 'C3:3.3': 'owner: we moved off the old staging box' }
const both = [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C2:2.2', quote: 'no squash merges on this repo' }]
const now = Date.parse('2026-11-21T03:00:00Z')
const mem = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-dream-'))
  writeFileSync(join(dir, 'MEMORY.md'), '- [Staging](staging.md): use the old staging box\n')
  writeFileSync(join(dir, 'staging.md'), 'Deploy to the old staging box.\n')
  return dir
}
const ledger = (dir: string) => readFileSync(join(dir, '.dream-ledger.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t').slice(1))

test('a kept lesson becomes a note with an index line, and a dropped one only a ledger line (#488)', () => {
  const dir = mem()
  const lessons: DreamLesson[] = [
    { kind: 'new', file: 'merge-style.md', text: 'Merge Kage PRs with a merge commit, never squash.', evidence: both, confidence: 0.9 },
    { kind: 'new', file: 'made-up.md', text: 'The owner loves tabs.', evidence: [{ key: 'C1:1.1', quote: 'I love tabs very much' }, both[1]!], confidence: 0.9 },
  ]
  const { said } = applyLessons({ dir, chats, lessons, limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(join(dir, 'merge-style.md'), 'utf8'), 'Merge Kage PRs with a merge commit, never squash.\n')
  assert.equal(existsSync(join(dir, 'made-up.md')), false)
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /^- \[merge-style\]\(merge-style\.md\): Merge Kage PRs with a merge commit, never squash\.$/m)
  assert.deepEqual(ledger(dir), [['new', 'merge-style.md', 'from C1:1.1, C2:2.2'], ['dropped', 'made-up.md', 'a quote is not in C1:1.1']])
  assert.match(said, /kept 1: merge-style\.md/)
  assert.match(said, /dropped 1: made-up\.md \(a quote is not in C1:1\.1\)/)
})

test('a lesson for a note that exists is added to it, not written over it', () => {
  const dir = mem()
  applyLessons({ dir, chats, lessons: [{ kind: 'new', file: 'staging.md', text: 'Never on Fridays.', evidence: both, confidence: 0.9 }], limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(join(dir, 'staging.md'), 'utf8'), 'Deploy to the old staging box.\n\nNever on Fridays.\n')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('\n').filter(l => l.includes('(staging.md)')).length, 1)
})

test('a kept outdated lesson moves its note to the archive and out of the index; one for a missing note is dropped', () => {
  const dir = mem()
  const ev = [{ key: 'C3:3.3', quote: 'we moved off the old staging box' }, both[0]!]
  const { said } = applyLessons({ dir, chats, lessons: [
    { kind: 'outdated', file: 'staging.md', text: 'The old staging box is gone.', evidence: ev, confidence: 0.9 },
    { kind: 'outdated', file: 'nothing.md', text: 'x', evidence: ev, confidence: 0.9 },
  ], limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(join(dir, '.archive', 'staging.md'), 'utf8'), 'Deploy to the old staging box.\n')
  assert.equal(readFileSync(join(dir, 'staging.md'), 'utf8'), '')
  assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /staging/)
  assert.deepEqual(ledger(dir).map(r => r.slice(0, 2)), [['outdated', 'staging.md'], ['dropped', 'nothing.md']])
  assert.match(said, /nothing\.md \(no note named nothing\.md\)/)
})

test('review fixes: a retired note is not retired twice, the index keeps lines that only mention it, a symlink is never written through, and a rerun adds nothing twice', () => {
  const dir = mem()
  writeFileSync(join(dir, 'MEMORY.md'), '- [Staging](staging.md): use the old staging box\n- [Deploys](deploys.md): see also (staging.md) for history\n')
  const ev = [{ key: 'C3:3.3', quote: 'we moved off the old staging box' }, both[0]!]
  const out = { kind: 'outdated' as const, file: 'staging.md', text: 'gone', evidence: ev, confidence: 0.9 }
  applyLessons({ dir, chats, lessons: [out], limits: DREAM_LIMITS, now })
  applyLessons({ dir, chats, lessons: [out], limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(join(dir, '.archive', 'staging.md'), 'utf8'), 'Deploy to the old staging box.\n')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Deploys](deploys.md): see also (staging.md) for history\n')
  const outside = join(mkdtempSync(join(tmpdir(), 'kage-out-')), 'target.md')
  writeFileSync(outside, 'outside\n')
  symlinkSync(outside, join(dir, 'link.md'))
  const { said } = applyLessons({ dir, chats, lessons: [{ kind: 'new', file: 'link.md', text: 'x', evidence: both, confidence: 0.9 }], limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n')
  assert.match(said, /link\.md \(link\.md is a link, not a note\)/)
  const lesson = { kind: 'new' as const, file: 'merge-style.md', text: 'Merge with a merge commit.', evidence: both, confidence: 0.9 }
  applyLessons({ dir, chats, lessons: [lesson], limits: DREAM_LIMITS, now })
  applyLessons({ dir, chats, lessons: [lesson], limits: DREAM_LIMITS, now })
  assert.equal(readFileSync(join(dir, 'merge-style.md'), 'utf8'), 'Merge with a merge commit.\n')
})
