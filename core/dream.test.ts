import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dreamDue, dreamTask } from './dream.ts'

process.env.TZ = 'Asia/Kolkata'   // the Mac's local time decides the small hours
const DAY = 24 * 3600_000
// 22:00 UTC is 03:30 in Kolkata.
const sun = Date.parse('2026-11-08T22:00:00Z')
test('a dream runs once a week, between 02:00 and 06:00 local time, only when every session is quiet', () => {
  assert.equal(dreamDue(sun, undefined, true), true)
  assert.equal(dreamDue(sun, undefined, false), false)                      // someone is working
  assert.equal(dreamDue(Date.parse('2026-11-08T12:00:00Z'), undefined, true), false)   // 17:30 IST
  assert.equal(dreamDue(sun, sun - 3 * DAY, true), false)                   // dreamt this week
  assert.equal(dreamDue(sun, sun - 7 * DAY, true), true)
})
test('the dream may change only its own memory, archives instead of deleting, and only reads the owner\'s', () => {
  const t = dreamTask({ own: '/m/kage', owner: '/m/owner' })
  assert.match(t, /\/m\/kage/)
  assert.match(t, /\/m\/kage\/\.archive/)
  assert.match(t, /never delete/i)
  assert.match(t, /\/m\/owner[^\n]*read only/i)
  assert.match(t, /\/m\/kage\/\.dream-ledger\.tsv/)
})
