import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dreamDue, dreamTask, threadsSince } from './dream.ts'

process.env.TZ = 'Asia/Kolkata'   // the Mac's local time decides the small hours
const HOUR = 3600_000, DAY = 24 * HOUR
// 22:00 UTC is 03:30 in Kolkata.
const sun = Date.parse('2026-11-08T22:00:00Z')
test('a dream runs every night, between 02:00 and 06:00 local time, only when every session is quiet', () => {
  assert.equal(dreamDue(sun, undefined, true), true)
  assert.equal(dreamDue(sun, undefined, false), false)                      // someone is working
  assert.equal(dreamDue(Date.parse('2026-11-08T12:00:00Z'), undefined, true), false)   // 17:30 IST
  assert.equal(dreamDue(sun, sun - 2 * HOUR, true), false)                  // dreamt earlier tonight
  assert.equal(dreamDue(sun, sun - DAY + 20 * 60_000, true), true)          // last night, a little later
})
test('the dream reads the threads that moved since the last dream, never its own', () => {
  const sessions = { 'C1:1.1': 'a', 'C2:2.2': 'b', 'dm#side-dream': 'c', 'dm': 'd' }
  const mtime: Record<string, number> = { a: sun - HOUR, b: sun - 2 * DAY, c: sun - HOUR }
  const got = threadsSince(sessions, id => mtime[id], sun - DAY)
  assert.deepEqual(got, [{ key: 'C1:1.1', id: 'a' }])                      // b is old, c is the dream, d has no transcript
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
  assert.match(t, /2026-11-08T00:00:00\.000Z/)                               // reads only what is new
  assert.match(t, /correct/i)
  assert.doesNotMatch(t, /no threads moved/i)
  assert.match(dreamTask({ own: '/m/kage', owner: '/m/owner' }, [], 'x'), /no threads moved/i)
})
