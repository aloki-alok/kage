import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dreamDue, dreamTask, threadsSince } from '../dream.ts'

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

test("the dream lists its memory folder first and changes it with Write and Edit, not a shell", () => {
  const t = dreamTask({ own: "/m/kage", owner: "/m/owner" }, [], "x")
  assert.match(t, /Glob tool \(path \/m\/kage/)
  assert.match(t, /only the listing says which files exist/i)
  assert.match(t, /Write and Edit tools, never a shell command/)
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
