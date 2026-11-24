import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cadence, promptPreview, cronJobsFromTranscript, cronMatches, liveCronJobs, dueSchedules, nextRun, parseCron, runTrust, EVENT, REPLY, type Schedule } from '../cron.ts'

const at = (s: string) => new Date(s)

describe('cron expressions, read like CronCreate reads them (local time)', () => {
  test('lists, ranges, steps and stars match the minutes they name', () => {
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-03T13:22:00')), true)
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-03T21:07:00')), false)
    assert.equal(cronMatches('7,22,37,52 13-20 3 11 *', at('2026-11-04T13:22:00')), false)
    assert.equal(cronMatches('*/15 * * * *', at('2026-11-03T10:45:00')), true)
    assert.equal(cronMatches('*/15 * * * *', at('2026-11-03T10:46:00')), false)
    assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-02T09:00:00')), true)
    assert.equal(cronMatches('0 9 * * 1-5', at('2026-11-01T09:00:00')), false)
  })
  test('day of month and day of week match either one when both are set, as cron does', () => {
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-02T09:00:00')), true)
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-01T09:00:00')), true)
    assert.equal(cronMatches('0 9 1 * 1', at('2026-11-03T09:00:00')), false)
  })
  test('a bad expression is refused with a reason', () => {
    assert.throws(() => parseCron('61 * * * *'), /minute/)
    assert.throws(() => parseCron('* * *'), /5 fields/)
    assert.throws(() => parseCron('*/0 * * * *'), /step/)
  })
  test('the next run is found within a window, or not at all', () => {
    assert.deepEqual(nextRun('7,37 8-23 * * *', at('2026-11-03T16:40:00'), 86_400_000), at('2026-11-03T17:07:00'))
    assert.equal(nextRun('0 0 3 11 *', at('2026-11-03T16:40:00'), 7 * 86_400_000), undefined)
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
    assert.deepEqual(sameMinute.fire, [])
    const fewMinutes = dueSchedules([s({ lastFired: at('2026-11-03T10:17:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual(fewMinutes.fire, [])
  })
  test('a job adopted with an end is dropped once that end passes', () => {
    const r = dueSchedules([s({ ends: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T10:15:20').getTime())
    assert.deepEqual([r.fire, r.drop], [[], ['j1']])
  })
  test('a hub that was down for long fires a missed run once, not a backlog', () => {
    const late = dueSchedules([s({ lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T11:05:00').getTime())
    assert.deepEqual(late.fire.map(x => x.id), ['j1'])
    assert.deepEqual(late.late, {})
    const longer = dueSchedules([s({ cron: '0 * * * *', lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T11:30:00').getTime())
    assert.deepEqual(longer.late.j1, { due: at('2026-11-03T11:00:00').getTime(), missed: 1 })
  })
  test('runs skipped while a lane was busy for a few minutes are not called late', () => {
    const r = dueSchedules([s({ cron: '*/5 * * * *', lastFired: at('2026-11-03T09:55:20').getTime() })], at('2026-11-03T10:05:20').getTime())
    assert.deepEqual([r.fire.map(x => x.id), r.late], [['j1'], {}])
  })
  test('a run on time is not late', () => {
    const r = dueSchedules([s({ lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T10:15:40').getTime())
    assert.deepEqual([r.fire.map(x => x.id), r.late], [['j1'], {}])
  })
  test('after a 3 h gap the newest missed run fires once, with the runs missed counted (#486)', () => {
    const daily = s({ cron: '0 9 * * *', created: at('2026-11-01T08:00:00').getTime(), lastFired: at('2026-11-02T09:00:00').getTime() })
    const r = dueSchedules([daily], at('2026-11-03T12:00:10').getTime())
    assert.deepEqual(r.fire.map(x => x.id), ['j1'])
    assert.deepEqual(r.late.j1, { due: at('2026-11-03T09:00:00').getTime(), missed: 1 })
    const often = dueSchedules([s({ lastFired: at('2026-11-03T10:00:00').getTime() })], at('2026-11-03T13:12:00').getTime())
    assert.deepEqual(often.late.j1, { due: at('2026-11-03T13:00:00').getTime(), missed: 12 })
  })
  test('a run older than the catch-up window fires nothing and is counted as skipped once (#486)', () => {
    const daily = s({ cron: '0 9 * * *', created: at('2026-11-01T08:00:00').getTime(), lastFired: at('2026-11-02T09:00:00').getTime() })
    const r = dueSchedules([daily], at('2026-11-03T22:01:00').getTime())
    assert.deepEqual([r.fire, r.skipped], [[], { j1: 1 }])
    const shorter = dueSchedules([daily], at('2026-11-03T12:00:10').getTime(), 2 * 3600_000)
    assert.deepEqual([shorter.fire, shorter.skipped], [[], { j1: 1 }])
    const nothingMissed = dueSchedules([s({ ...daily, lastFired: at('2026-11-03T09:00:00').getTime() })], at('2026-11-03T22:01:00').getTime())
    assert.deepEqual([nothingMissed.fire, nothingMissed.skipped], [[], {}])
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

test('a watch never fires on the clock, and is dropped once it ends', () => {
  const w: Schedule = { id: 'w', key: 'C1:1.1', cron: REPLY, prompt: 'p', recurring: true, fromOwner: false, created: 0, lastFired: 0, ends: 10 * 60_000 }
  assert.deepEqual(dueSchedules([w], 5 * 60_000), { fire: [], drop: [], late: {}, skipped: {} })
  assert.deepEqual(dueSchedules([w], 10 * 60_000), { fire: [], drop: ['w'], late: {}, skipped: {} })
})

describe('a schedule in words', () => {
  test('a job only an event wakes has no next run, and says what wakes it', () => {
    assert.equal(nextRun(EVENT, new Date(), 24 * 3600_000), undefined)
    assert.equal(nextRun(REPLY, new Date(), 24 * 3600_000), undefined)
    assert.equal(cadence(EVENT), 'when its trigger fires')
  })
  test('the shapes people set read as plain English; anything else stays as written', () => {
    assert.equal(cadence('*/30 * * * *'), 'every 30 min')
    assert.equal(cadence('*/15 9-18 * * 1-5'), 'every 15 min, 09:00 to 18:59, weekdays')
    assert.equal(cadence('7 8-23 * * *'), 'hourly at :07, 08:00 to 23:59')
    assert.equal(cadence('31 19 * * *'), 'daily at 19:31')
    assert.equal(cadence('*/30 8-23 6 11 *'), 'every 30 min, 08:00 to 23:59, on 6 Nov')
    assert.equal(cadence('0 9 * * 1'), 'daily at 09:00, Mondays')
    assert.equal(cadence('@reply'), 'when someone writes')
    assert.equal(cadence('5,35 * * * *'), '5,35 * * * *')
    assert.equal(cadence('0 9 6 11 1'), '0 9 6 11 1')
    assert.equal(cadence('*/7 * * * *'), '*/7 * * * *')
  })
})

test('a schedule prompt reads without the Slack ids the hub needs', () => {
  assert.equal(promptPreview('Stock alarm for #telephony thread C0TESTAAA11 / 1700000000.000001 (asked by Priya U0TESTBBB22). Steps:\nmore'), 'Stock alarm for #telephony. Steps:')
  assert.equal(promptPreview('Newsletter monitor (thread C0TESTCCC33 / 1700000000.000002). Check'), 'Newsletter monitor. Check')
  assert.equal(promptPreview('Check DASHBOARD and CUSTOMERS (see DEPLOYMENT notes)'), 'Check DASHBOARD and CUSTOMERS (see DEPLOYMENT notes)')
})

test('an event job never fires on the clock', () => {
  const e: Schedule = { id: 'e', key: 'C1:1.1', cron: EVENT, prompt: 'p', recurring: true, fromOwner: false, created: 0, lastFired: 0 }
  assert.deepEqual(dueSchedules([e], 3_600_000), { fire: [], drop: [], late: {}, skipped: {} })
})

describe("runTrust: whose trust a job's woken runs get", () => {
  const job = (o: Partial<Schedule> = {}): Schedule => ({ id: 'a1', key: 'C1:1.1', cron: '*/10 * * * *', prompt: 'p', recurring: true, fromOwner: true, created: 0, lastFired: 0, ...o })
  const on = { ownerThread: true, probesOn: true }
  test("the owner's clock job in the owner's thread runs as the owner", () => assert.equal(runTrust(job(), on), 'owner'))
  test("the owner's clock job in a thread a teammate wrote in runs as a teammate", () => assert.equal(runTrust(job(), { ...on, ownerThread: false }), 'teammate'))
  test("a teammate's clock job runs as a teammate", () => assert.equal(runTrust(job({ fromOwner: false }), on), 'teammate'))
  test('an event, hook or watch job is woken as a teammate', () => {
    assert.equal(runTrust(job({ cron: EVENT, trigger: { kind: 'hook', tokenHash: 'x' } }), on), 'wake')
    assert.equal(runTrust(job({ cron: REPLY }), on), 'wake')
  })
  test('a probe job is woken as a teammate while tripwires are on, and runs on its clock as the owner when off', () => {
    const probe = job({ trigger: { kind: 'probe', probe: {} as never } })
    assert.equal(runTrust(probe, on), 'wake')
    assert.equal(runTrust(probe, { ...on, probesOn: false }), 'owner')
  })
})
