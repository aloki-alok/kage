import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retro, retroDue } from '../retro.ts'
import { tsvRow } from '../ledgers.ts'
import type { Schedule } from '../cron.ts'

const DAY = 24 * 3600_000, HOUR = 3600_000
const now = Date.parse('2026-11-09T09:00:00Z')
const sched = (id: string, key = 'C1:1.1'): Schedule => ({ id, key, cron: '*/30 * * * *', prompt: 'check', recurring: true, fromOwner: true, created: now - 30 * DAY, lastFired: 0 })
const at = (t: number) => new Date(t).toISOString()
const runs = (id: string, key: string, n: number, from = now) => Array.from({ length: n }, (_, i) => tsvRow([at(from - i * HOUR), id, key])).join('')
const post = (key: string, t: number, by = 'bot') => tsvRow([at(t), key.split(':')[0]!, `${t / 1000}`, by, key])
const base = { placeOf: (k: string) => `#${k}`, runs: '', posted: '', costs: '', now }

test('a schedule that ran often and almost never posted in its thread gets a proposal with the way to cancel it', () => {
  const text = retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 70), posted: post('C1:1.1', now - DAY) }).join('\n')
  assert.match(text, /aa in #C1:1\.1: ran 70 times this week, posted 1 time/)
  assert.match(text, /unschedule aa/)
})

test('runs are counted from the run ledger, not guessed from the cron', () => {
  assert.deepEqual(retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 19) }), [])
})

test('posts count for the schedule\'s own session, private replies included, by the bot or as the owner, within the week', () => {
  const others = Array.from({ length: 30 }, (_, i) => post('C1:9.9', now - i * HOUR)).join('')   // another thread, same channel
  const flagged = retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 40), posted: others + post('C1:1.1', now - 8 * DAY) })
  assert.match(flagged.join('\n'), /posted 0 times/)
  const asOwner = Array.from({ length: 10 }, (_, i) => post('C1:1.1', now - i * HOUR, 'owner')).join('')
  assert.deepEqual(retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 40), posted: asOwner }), [])
  const privately = Array.from({ length: 10 }, (_, i) => tsvRow([at(now - i * HOUR), 'DBOT', '1.1', 'bot', 'C1:1.1'])).join('')
  assert.deepEqual(retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 40), posted: privately }), [])
})

test('a cancelled schedule is not proposed, and runs older than a week do not count', () => {
  assert.deepEqual(retro({ ...base, schedules: [], runs: runs('aa', 'C1:1.1', 70) }), [])
  assert.deepEqual(retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 70, now - 8 * DAY) }), [])
})

test('the threads that cost most this week are listed, three at most', () => {
  const costs = ['a', 'b', 'c', 'd'].map((k, i) => tsvRow([at(now - DAY), k, String(i + 1), '0'])).join('')
  const text = retro({ ...base, schedules: [], costs }).join('\n')
  assert.match(text, /\$4\.00 #d/)
  assert.doesNotMatch(text, /#a\b/)
})

test('with threads as tmux panes, the retro says spend is not tracked instead of listing none', () => {
  const text = retro({ ...base, schedules: [sched('aa')], runs: runs('aa', 'C1:1.1', 70), costTracked: false }).join('\n')
  assert.match(text, /unschedule aa/)
  assert.match(text, /not tracked.*tmux/)
  assert.equal(retro({ ...base, schedules: [], costTracked: false }).length, 0)   // the note alone sends no DM
})

test('due once a week, from Monday 09:00 on the Mac clock, or later in the week if Monday was missed', () => {
  const monday9 = new Date(2026, 10, 9, 9, 5).getTime()   // local time, whatever the zone
  assert.equal(retroDue(monday9, undefined), true)
  assert.equal(retroDue(monday9 - 10 * 60_000, undefined), false)         // 08:55
  assert.equal(retroDue(monday9 + 15 * HOUR, monday9), false)             // sent this morning
  assert.equal(retroDue(monday9 + 7 * DAY, monday9), true)
  assert.equal(retroDue(monday9 + HOUR, monday9), false)                  // sent an hour ago
  assert.equal(retroDue(monday9 + DAY, undefined), true)                  // the Mac slept through Monday
  assert.equal(retroDue(monday9 - DAY, undefined), false)                 // Sunday
})
