import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cronJobsFromTranscript, cronMatches, liveCronJobs, dueSchedules, nextRun, parseCron, type Schedule } from './cron.ts'

// Local time, as Claude Code's CronCreate reads its expressions.
const at = (s: string) => new Date(s)

describe('cron expressions, read like CronCreate reads them (local time)', () => {
  test('lists, ranges, steps and stars match the minutes they name', () => {
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-03T13:22:00')), true)
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-03T21:07:00')), false)
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-04T13:22:00')), false)
    assert.equal(cronMatches('*/15 * * * *', at('2026-11-03T10:45:00')), true)
    assert.equal(cronMatches('*/15 * * * *', at('2026-11-03T10:46:00')), false)
    assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-02T09:00:00')), true)    // a Monday
    assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-01T09:00:00')), false)   // a Sunday
  })
  test('day of month and day of week match either one when both are set, as cron does', () => {
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-02T09:00:00')), true)      // Monday, not the 1st
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-01T09:00:00')), true)      // the 1st, a Sunday
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-03T09:00:00')), false)
  })
  test('a bad expression is refused with a reason', () => {
    assert.throws(() => parseCron('61 * * * *'), /minute/)
    assert.throws(() => parseCron('* * *'), /5 fields/)
    assert.throws(() => parseCron('*/0 * * * *'), /step/)
  })
  test('the next run is found within a window, or not at all', () => {
    assert.deepEqual(nextRun('7,37 8-23 * * *', at('2026-11-03T16:40:00'), 86_400_000), at('2026-11-03T17:07:00'))
    assert.equal(nextRun('0 0 3 11 *', at('2026-11-03T16:40:00'), 7 * 86_400_000), undefined)   // next year
  })
})

describe('which schedules fire now', () => {
  const s = (o: Partial<Schedule>): Schedule => ({
    id: 'j1', key: 'C1:5.5', cron: '*/15 * * * *', prompt: 'check', recurring: true, fromOwner: true,
    created: at('2026-11-03T10:00:00').getTime(), lastFired: 0, ...o,
  })
  test('a schedule fires once for a matching minute since it last fired, even if the tick came late', () => {
    const r = dueSchedules([s({})], at('2026-11-03T10:15:40').getTime())
    assert.deepEqual(r.fire.map(x => x.id), ['j1'])
    const again = dueSchedules([s({ lastFired: at('2026-11-03T10:15:40').getTime() })], at('2026-11-03T10:16:10').getTime())
    assert.deepEqual(again.fire, [])
  })
  test('after the clock jumps back, a job still runs', () => {
    const r = dueSchedules([s({ lastFired: at('2026-11-03T12:00:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual(r.fire.map(x => x.id), ['j1'])
    const sameMinute = dueSchedules([s({ lastFired: at('2026-11-03T10:15:40').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual(sameMinute.fire, [])                 // stepped back within the minute it already ran
    const fewMinutes = dueSchedules([s({ lastFired: at('2026-11-03T10:17:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual(fewMinutes.fire, [])                 // 10:15 ran before the step back
  })
  test('a job adopted with an end is dropped once that end passes', () => {
    const r = dueSchedules([s({ ends: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([r.fire, r.drop], [[], ['j1']])
  })
  test('a hub that was down for long fires a missed run once, not a backlog, and not one older than 10 min', () => {
    const late = dueSchedules([s({ lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T11:05:00').getTime())
    assert.deepEqual(late.fire.map(x => x.id), ['j1'])   // 11:00 was 5 min ago
    const stale = dueSchedules([s({ cron: '0 * * * *', lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T11:30:00').getTime())
    assert.deepEqual(stale.fire, [])                      // 11:00 was 30 min ago: skipped
  })
  test('a one-shot is dropped after it fires; a recurring one never ends unless someone cancels it', () => {
    const once = dueSchedules([s({ recurring: false, cron: '15 10 3 11 *' })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([once.fire.map(x => x.id), once.drop], [['j1'], ['j1']])
    const old = dueSchedules([s({ created: at('2026-09-01T09:00:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([old.fire.map(x => x.id), old.drop], [['j1'], []])
  })
  test('a one-shot missed while the hub was down still fires when it comes back', () => {
    const missed = dueSchedules([s({ recurring: false, cron: '0 8 3 11 *', created: at('2026-11-03T07:00:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([missed.fire.map(x => x.id), missed.drop], [['j1'], ['j1']])
    const future = dueSchedules([s({ recurring: false, cron: '0 8 4 11 *' })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([future.fire, future.drop], [[], []])
  })
})

describe('the cron jobs still alive in a Claude Code transcript', () => {
  const line = (o: object) => JSON.stringify(o)
  const create = (id: string, input: object, t: string) => [
    line({ timestamp: t, message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'CronCreate', input }] } }),
    line({ timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: `Scheduled ${(input as { recurring: boolean }).recurring ? 'recurring' : 'one-shot'} job ${id} (x). Next run: soon.` }] } }),
  ]
  test('jobs made by the running process and not cancelled come back with their cron and prompt', () => {
    const lines = [
      ...create('aa11', { cron: '0 9 * * *', prompt: 'old process', recurring: true }, '2026-11-01T00:00:00Z'),
      ...create('bb22', { cron: '7,37 8-23 * * *', prompt: 'watch leads', recurring: true }, '2026-11-03T03:30:31Z'),
      ...create('cc33', { cron: '*/5 * * * *', prompt: 'gone', recurring: true }, '2026-11-03T04:00:00Z'),
      line({ timestamp: '2026-11-03T05:00:00Z', message: { content: [{ type: 'tool_result', content: 'Cancelled job cc33.' }] } }),
      'not json',
    ]
    const jobs = cronJobsFromTranscript(lines, Date.parse('2026-11-02T00:00:00Z'))
    assert.deepEqual(jobs, [{ id: 'bb22', cron: '7,37 8-23 * * *', prompt: 'watch leads', recurring: true, created: Date.parse('2026-11-03T03:30:31Z') }])
  })
})

describe('a session with a repeating check stays open', () => {
  const H = 3600_000
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * H).toISOString()
  const made = (id: string, h: number, kind = 'recurring') => ({ timestamp: at(h), text: `Scheduled ${kind} job ${id} (*/5 * * * *). Next run: ...` })
  const cancelled = (id: string, h: number) => ({ timestamp: at(h), text: `Cancelled job ${id}.` })
  const t0 = Date.parse(at(0))

  test('a job made by the running process counts until it is cancelled', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0, t0 + 2 * H), ['aa11'])
    assert.deepEqual(liveCronJobs([made('aa11', 1), cancelled('aa11', 2)], t0, t0 + 3 * H), [])
  })
  test('a job made before this process started died with the old one', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0 + 2 * H, t0 + 3 * H), [])
  })
  test('a recurring job expires after 7 days, a one-shot after a day', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0, t0 + 7 * 24 * H + 2 * H), [])
    assert.deepEqual(liveCronJobs([made('bb22', 1, 'one-shot')], t0, t0 + 3 * H), ['bb22'])
    assert.deepEqual(liveCronJobs([made('bb22', 1, 'one-shot')], t0, t0 + 26 * H), [])
  })
})
