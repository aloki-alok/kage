import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, boardRows, nextRuns, watchingNext, whenLabel, type Live, clockTime, pauseLine } from './board.ts'
import type { Schedule } from './cron.ts'

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const NOW = new Date(2026, 10, 3, 17, 42, 0).getTime()   // local time, so the tests hold in any zone
const known = (...keys: string[]) => keys.map(key => ({ key, place: `#${key}`, lastSeen: NOW - 5 * HOUR, connector: 'slack' }))
const live = (o: Partial<Live> = {}): Live => ({ live: [], waiting: [], held: [], max: 6, ...o })
const rows = (k: ReturnType<typeof known>, l: Live | undefined, extra: { activity?: Map<string, number>; next?: Map<string, number> } = {}) =>
  boardRows(k, l, extra.activity ?? new Map(), extra.next ?? new Map(), NOW)

describe('what each thread is doing, in the order the owner must look', () => {
  test('hub states become plain labels', () => {
    const r = rows(known('a', 'b', 'c', 'd', 'e', 'f', 'g'), live({
      live: [
        { key: 'a', state: 'busy', quietMs: 4_000 }, { key: 'b', state: 'asking', quietMs: 2 * MIN },
        { key: 'c', state: 'starting', quietMs: 1_000 }, { key: 'd', state: 'quiet', quietMs: 9 * MIN },
        { key: 'g', state: 'watching', quietMs: 3 * MIN },
      ],
      waiting: ['e'], held: ['f'],
    })).rows
    assert.deepEqual(Object.fromEntries(r.map(x => [x.key, [x.state, x.label]])), {
      a: ['working', 'working'], b: ['asking', 'asks you'], c: ['starting', 'starting'],
      d: ['quiet', 'quiet'], e: ['queued', 'queued'], f: ['held', 'in terminal'], g: ['watching', 'watching'],
    })
  })
  test('a thread the hub does not run is closed', () => {
    assert.equal(rows(known('a'), live()).rows[0]!.state, 'closed')
  })
  test('what asks you comes first, then work, starting, watching, then the rest by how recent; closed last', () => {
    const r = rows(known('closed', 'quiet-old', 'quiet-new', 'work', 'ask', 'held', 'watch', 'start'), live({
      live: [
        { key: 'quiet-old', state: 'quiet', quietMs: 20 * MIN }, { key: 'quiet-new', state: 'quiet', quietMs: 2 * MIN },
        { key: 'work', state: 'busy', quietMs: 0 }, { key: 'ask', state: 'asking', quietMs: 30 * MIN },
        { key: 'watch', state: 'watching', quietMs: 1 * MIN }, { key: 'start', state: 'starting', quietMs: 0 },
      ],
      held: ['held'],
    }))
    assert.deepEqual(r.rows.map(x => x.key), ['ask', 'work', 'start', 'watch', 'held', 'quiet-new', 'quiet-old', 'closed'])
  })
  test('last activity is the hub quiet time for a live thread, else the newest of the store and the transcript', () => {
    const r = rows(known('a', 'b', 'c'), live({ live: [{ key: 'a', state: 'quiet', quietMs: 9 * MIN }] }),
      { activity: new Map([['b', NOW - 3 * MIN], ['c', NOW - 9 * HOUR]]) }).rows
    assert.deepEqual(Object.fromEntries(r.map(x => [x.key, x.ageMs])), { a: 9 * MIN, b: 3 * MIN, c: 5 * HOUR })
  })
  test('every closed thread is listed, newest first, with the channel it came from', () => {
    const k = [{ key: 'old', place: '#old', lastSeen: NOW - 9 * DAY, connector: 'email' }, { key: 'new', place: '#new', lastSeen: NOW - HOUR, connector: 'whatsapp' }]
    const r = boardRows(k, live(), new Map(), new Map(), NOW).rows
    assert.deepEqual(r.map(x => [x.key, x.connector]), [['new', 'whatsapp'], ['old', 'email']])
  })
  test('with the hub down every thread reads closed, so nothing looks alive that is not', () => {
    const r = rows(known('a'), undefined)
    assert.equal(r.rows[0]!.state, 'closed')
  })
  test('a thread carries its next scheduled run', () => {
    assert.equal(rows(known('a', 'b'), live(), { next: new Map([['a', NOW + 10 * MIN]]) }).rows.find(x => x.key === 'a')!.next, NOW + 10 * MIN)
  })
})

describe('times as people read them', () => {
  test('ago', () => {
    assert.deepEqual([4_000, 59_000, 9 * MIN, 59 * MIN, 2 * HOUR + 5 * MIN, 3 * DAY].map(ago), ['4s', '59s', '9m', '59m', '2h', '3d'])
    assert.equal(ago(-5000), '0s')
  })
  test('whenLabel: a clock time today, a weekday and time later, a dash for none', () => {
    assert.equal(whenLabel(new Date(2026, 10, 3, 17, 52).getTime(), NOW), '17:52')
    assert.equal(whenLabel(new Date(2026, 10, 4, 9, 5).getTime(), NOW), 'Wed 09:05')
    assert.equal(whenLabel(undefined, NOW), '-')
  })
})

describe('what a watching session waits for', () => {
  const made = (id: string, cron: string, recurring: boolean, at: number) => [
    JSON.stringify({ timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', id: `u${id}`, name: 'CronCreate', input: { cron, prompt: 'p', recurring } }] } }),
    JSON.stringify({ timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: `u${id}`, content: `Scheduled ${recurring ? 'recurring' : 'one-shot'} job ${id}` }] } }),
  ]
  test('the soonest run of the timed checks it still holds', () => {
    const lines = [...made('aa', '0 9 * * *', true, NOW - HOUR), ...made('bb', '50 17 * * *', true, NOW - HOUR)]
    assert.equal(watchingNext(lines, NOW), new Date(2026, 10, 3, 17, 50).getTime())
  })
  test('a cancelled check and an old one-shot do not count', () => {
    const cancel = JSON.stringify({ timestamp: new Date(NOW).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Cancelled job aa' }] } })
    const lines = [...made('aa', '50 17 * * *', true, NOW - HOUR), cancel, ...made('cc', '50 17 * * *', false, NOW - 3 * DAY)]
    assert.equal(watchingNext(lines, NOW), undefined)
  })
  test('nothing in the transcript reads as no next run', () => {
    assert.equal(watchingNext([], NOW), undefined)
  })
})

describe('next run per thread', () => {
  const sched = (o: Partial<Schedule>): Schedule => ({ id: 'x', key: 'a', cron: '*/15 * * * *', prompt: 'p', recurring: true, fromOwner: true, created: NOW - DAY, lastFired: 0, ...o })
  test('the soonest run among the thread schedules', () => {
    const m = nextRuns([sched({ cron: '0 9 * * *' }), sched({ id: 'y', cron: '50 17 * * *' }), sched({ id: 'z', key: 'b', cron: '45 17 * * *' })], NOW)
    assert.equal(m.get('a'), new Date(2026, 10, 3, 17, 50).getTime())
    assert.equal(m.get('b'), new Date(2026, 10, 3, 17, 45).getTime())
  })
  test('a one-time schedule that already ran, an ended one and an unreadable one show nothing', () => {
    const m = nextRuns([
      sched({ recurring: false, lastFired: NOW - MIN }),
      sched({ id: 'e', cron: '50 17 * * *', ends: NOW + MIN }),
      sched({ id: 'bad', cron: 'nonsense' }),
    ], NOW)
    assert.equal(m.size, 0)
  })
})

describe('the usage-limit pause, as kage status and kage list show it', () => {
  test('one line with the reset time and how many messages are held', () => {
    const at = new Date(2026, 10, 3, 18, 5).getTime()
    assert.equal(pauseLine({ until: at, held: 3 }, at - 3600_000), 'Paused by the usage limit until 18:05. 3 messages are held, and they run then.')
    assert.equal(pauseLine({ until: at, held: 1 }, at - 3600_000), 'Paused by the usage limit until 18:05. 1 message is held, and it runs then.')
    assert.equal(pauseLine({ until: at, held: 0 }, at - 3600_000), 'Paused by the usage limit until 18:05. No message is held.')
  })
})
