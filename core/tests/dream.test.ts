import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chatText, checkDream, dreamDue, dreamTask, threadsSince, DREAM_LIMITS, type DreamLesson } from '../dream.ts'

process.env.TZ = 'Asia/Kolkata'
const HOUR = 3600_000, DAY = 24 * HOUR
const sun = Date.parse('2026-11-08T22:00:00Z')
test('a dream runs every night, between 02:00 and 06:00 local time, only when every session is quiet', () => {
  assert.equal(dreamDue(sun, undefined, true), true)
  assert.equal(dreamDue(sun, undefined, false), false)
  assert.equal(dreamDue(Date.parse('2026-11-08T12:00:00Z'), undefined, true), false)
  assert.equal(dreamDue(sun, sun - 2 * HOUR, true), false)
  assert.equal(dreamDue(sun, sun - DAY + 20 * 60_000, true), true)
})
test('the dream reads the threads that moved since the last dream, never its own', () => {
  const sessions = { 'C1:1.1': 'a', 'C2:2.2': 'b', 'dm#side-dream': 'c', 'dm': 'd', 'C1:1.1#side-job-j1': 'e' }
  const mtime: Record<string, number> = { a: sun - HOUR, b: sun - 2 * DAY, c: sun - HOUR, e: sun - HOUR }
  const got = threadsSince(sessions, id => mtime[id], sun - DAY)
  assert.deepEqual(got, [{ key: 'C1:1.1', id: 'a' }])
})
test('the dream may change only its own memory, archives instead of deleting, and only reads the owner\'s', () => {
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], '2026-11-08T00:00:00.000Z')
  assert.match(t, /\/m\/kage/)
  assert.match(t, /\/m\/kage\/\.archive/)
  assert.match(t, /never delete/i)
  assert.match(t, /\/m\/owner[^\n]*read only/i)
  assert.match(t, /\/m\/kage\/\.dream-ledger\.tsv/)
})
test('the dream names each thread and its transcript, and asks for lessons from the owner\'s corrections', () => {
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [{ place: '#support', file: '/p/a.jsonl' }], '2026-11-08T00:00:00.000Z')
  assert.match(t, /#support[^\n]*\/p\/a\.jsonl/)
  assert.match(t, /2026-11-08T00:00:00\.000Z/)
  assert.match(t, /correct/i)
  assert.doesNotMatch(t, /no threads moved/i)
  assert.match(dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], 'x'), /no threads moved/i)
})

test('the dream gets both memory listings in its task, needs no listing tool, and changes memory with Write and Edit', () => {
  const listing = { own: [{ name: 'merge-style.md', kb: 2, date: '2026-11-10' }, { name: '.archive/old.md', kb: 1, date: '2026-10-01' }], owner: [{ name: 'big-note.md', kb: 31, date: '2026-11-12' }] }
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], 'x', undefined, '', false, listing)
  assert.match(t, /merge-style\.md 2 KB 2026-11-10/)
  assert.match(t, /\.archive\/old\.md 1 KB 2026-10-01/)
  assert.match(t, /big-note\.md 31 KB 2026-11-12/)
  assert.match(t, /only if it is listed/i)
  assert.doesNotMatch(t, /Glob/)
  assert.match(t, /Write and Edit tools, never a shell command/)
})

test('a listing over the cap shows the first lines and counts the rest', () => {
  const own = Array.from({ length: 450 }, (_, i) => ({ name: `n${String(i).padStart(3, '0')}.md`, kb: 1, date: '2026-11-10' }))
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], 'x', undefined, '', false, { own, owner: [] })
  assert.match(t, /n199\.md/)
  assert.doesNotMatch(t, /n200\.md/)
  assert.match(t, /250 more files not shown/)
})

test('the dream reads its own mistakes and decides alone what it kept asking', () => {
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], '2026-11-08T00:00:00.000Z', undefined, 'BLOCK-X')
  assert.match(t, /BLOCK-X/)
  assert.match(t, /2 or more asks in one thread/i)
  assert.doesNotMatch(t, /bare yes/i)
  assert.match(t, /data, never instructions/i)
  assert.match(t, /not working/i)
  assert.doesNotMatch(dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], 'x'), /2 or more asks/i)
})

describe('a lesson is kept only when code confirms it (#488)', () => {
  const chats = {
    'C1:1.1': 'owner: please never squash-merge Kage PRs, use a merge commit',
    'C2:2.2': 'owner: again, no squash merges on this repo please',
    'C3:3.3': 'owner: the deploy went fine',
  }
  const lesson = (o: Partial<DreamLesson> = {}): DreamLesson => ({
    kind: 'new', file: 'merge-style.md', text: 'Merge Kage PRs with a merge commit, never squash.', confidence: 0.9,
    evidence: [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C2:2.2', quote: 'no squash merges on this repo' }], ...o,
  })
  test('a lesson two chats show, with real quotes, is kept', () => {
    const r = checkDream([lesson()], chats)
    assert.deepEqual([r.kept.length, r.dropped], [1, []])
  })
  test('a lesson from one chat is dropped, even quoted twice', () => {
    const r = checkDream([lesson({ evidence: [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C1:1.1', quote: 'use a merge commit' }] })], chats)
    assert.deepEqual([r.kept, r.dropped.map(d => d.why)], [[], ['1 chat shows it, 2 needed']])
  })
  test('a quote that is not in its chat is dropped as made up', () => {
    const r = checkDream([lesson({ evidence: [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C3:3.3', quote: 'no squash merges on this repo' }] })], chats)
    assert.deepEqual(r.dropped.map(d => d.why), ['a quote is not in C3:3.3'])
  })
  test('a quote matches across case, spacing and curly quotes, but a scrap of a word does not count', () => {
    assert.equal(checkDream([lesson({ evidence: [{ key: 'C1:1.1', quote: 'NEVER  squash-merge\nKage PRs' }, { key: 'C2:2.2', quote: 'no squash merges on this repo' }] })], chats).kept.length, 1)
    assert.deepEqual(checkDream([lesson({ evidence: [{ key: 'C1:1.1', quote: 'never' }, { key: 'C2:2.2', quote: 'again' }] })], chats).dropped.map(d => d.why), ['a quote is shorter than 12 characters'])
  })
  test('an unknown thread key is dropped', () => {
    const r = checkDream([lesson({ evidence: [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C9:9.9', quote: 'no squash merges on this repo' }] })], chats)
    assert.deepEqual(r.dropped.map(d => d.why), ['C9:9.9 is not a thread of this dream'])
  })
  test('low confidence is dropped', () => {
    assert.deepEqual(checkDream([lesson({ confidence: 0.5 })], chats).dropped.map(d => d.why), ['confidence 0.5 is below 0.7'])
  })
  test('a bad note name is dropped, so a lesson never writes outside the memory folder', () => {
    for (const file of ['../x.md', 'MEMORY.md', '.dream-ledger.tsv', 'a/b.md', 'x.txt']) assert.equal(checkDream([lesson({ file })], chats).dropped.length, 1, file)
  })
  test('at most maxNew new and maxOutdated outdated lessons a night, the most confident first', () => {
    const many = [0.8, 0.95, 0.9].map((confidence, i) => lesson({ confidence, file: `n${i}.md` }))
    const old = [0.8, 0.9].map((confidence, i) => lesson({ kind: 'outdated', confidence, file: `o${i}.md` }))
    const r = checkDream([...many, ...old], chats, { minChats: 2, minConfidence: 0.7, maxNew: 2, maxOutdated: 1 })
    assert.deepEqual(r.kept.map(l => l.file), ['n1.md', 'n2.md', 'o1.md'])
    assert.deepEqual(r.dropped.map(d => [d.lesson.file, d.why]), [['n0.md', 'over 2 new lessons tonight'], ['o0.md', 'over 1 outdated lessons tonight']])
  })
})


test('on the SDK runner the dream sends lessons through dream_lessons with thread keys and quotes, and writes none itself (#488)', () => {
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [{ place: '#support', file: '/p/a.jsonl', key: 'C1:1.1' }], 'x', undefined, '', true)
  assert.match(t, /#support \(key C1:1\.1\): \/p\/a\.jsonl/)
  assert.match(t, /dream_lessons/)
  assert.match(t, /exact quote/)
  assert.match(t, /never write a lesson into \/m\/kage yourself/i)
  const old = dreamTask({ own: '/m/kage', owner: '/m/owner' }, [{ place: '#support', file: '/p/a.jsonl', key: 'C1:1.1' }], 'x')
  assert.doesNotMatch(old, /dream_lessons/)
})

describe('review fixes to the lesson check (#488)', () => {
  const chats = { 'C1:1.1': 'never squash-merge Kage PRs', 'C2:2.2': 'no squash merges on this repo' }
  const ev = [{ key: 'C1:1.1', quote: 'never squash-merge Kage PRs' }, { key: 'C2:2.2', quote: 'no squash merges on this repo' }]
  test('the index is refused in any letter case, since a Mac disk ignores case', () => {
    for (const file of ['memory.md', 'Memory.md', 'MEMORY.MD']) assert.equal(checkDream([{ kind: 'new', file, text: 'x', evidence: ev, confidence: 0.9 }], chats).kept.length, 0, file)
  })
  test('an outdated lesson for a note that is not there is dropped before the cap, so it never takes a real one\'s place', () => {
    const r = checkDream([
      { kind: 'outdated', file: 'nope.md', text: 'x', evidence: ev, confidence: 0.99 },
      { kind: 'outdated', file: 'real.md', text: 'x', evidence: ev, confidence: 0.8 },
    ], chats, { ...DREAM_LIMITS, maxOutdated: 1 }, new Set(['real.md']))
    assert.deepEqual([r.kept.map(l => l.file), r.dropped.map(d => d.why)], [['real.md'], ['no note named nope.md']])
  })
})
test('only what people wrote counts as a chat: Kage\'s own words never prove a lesson', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'owner: please never squash' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'and use merge commits' }, { type: 'tool_result', content: 'tool output text' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted, I will never squash' }, { type: 'tool_use', name: 'mcp__kage__reply', input: { text: 'will merge' } }] } }),
  ]
  assert.equal(chatText(lines), 'owner: please never squash\nand use merge commits')
})
