import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, boardRows, FOLDED, liveThreadLines, topicOf, statusSummary, type Row, nextRuns, watchingNext, whenLabel, type Live, clockTime, limitLine, pauseLine, stopLine } from '../board.ts'
import type { Schedule } from '../cron.ts'
import { startsSince } from '../boots.ts'

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const NOW = new Date(2026, 10, 3, 17, 42, 0).getTime()
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
  test('with ended sessions shown, every closed thread is listed, newest first, with the channel it came from', () => {
    const k = [{ key: 'old', place: '#old', lastSeen: NOW - 9 * DAY, connector: 'email' }, { key: 'new', place: '#new', lastSeen: NOW - HOUR, connector: 'whatsapp' }]
    const r = boardRows(k, live(), new Map(), new Map(), NOW, true).rows
    assert.deepEqual(r.filter(x => x.key !== FOLDED).map(x => [x.key, x.connector]), [['new', 'whatsapp'], ['old', 'email']])
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
    assert.equal(pauseLine({ until: at, held: 2, draining: true }, at - 5000), 'Stopping for a restart or a stop: new messages wait. 2 messages are held, and they run after it.')
    assert.equal(pauseLine({ until: at, held: 0 }, at - 3600_000), 'Paused by the usage limit until 18:05. No message is held.')
  })
})

describe('a reset time for a person', () => {
  test('a reset on another day names the day, so a weekly limit does not read as today', () => {
    const now = new Date(2026, 10, 3, 18, 5).getTime()
    assert.equal(clockTime(now + 30 * 60_000, now), '18:35')
    assert.equal(clockTime(new Date(2026, 10, 6, 9, 0).getTime(), now), 'Fri 6 Nov 09:00')
    assert.equal(clockTime(new Date(2026, 10, 4, 0, 30).getTime(), now), 'Wed 4 Nov 00:30')
  })
})

describe('what the usage limit cost since the hub started', () => {
  test('one line with the four counts, and nothing when the limit never hit', () => {
    assert.equal(limitLine({ limitHits: 2, held: 5, replays: 4, replayFailures: 1 }), 'Usage limit since the hub started: 2 hits, 5 held, 4 replayed, 1 replay failed.')
    assert.equal(limitLine({ limitHits: 0, held: 0, replays: 0, replayFailures: 0 }), undefined)
    assert.equal(limitLine(undefined), undefined)
  })
})

describe('the answer to a stop', () => {
  test('it says when the session ends, what was let go, and which schedules keep running', () => {
    assert.equal(stopLine({ ok: true, ending: true, dropped: 0 }, []), 'Stopping after the current turn. The next tag starts it again.')
    assert.equal(stopLine({ ok: true, cut: 'busy', dropped: 2 }, ['daily report', 'watch the deploy']),
      'Stopped now: the turn in progress was cut. 2 waiting messages were let go. Its 2 schedules keep running: daily report; watch the deploy. The next tag starts it again.')
    assert.equal(stopLine({ ok: true, cut: 'asking', dropped: 1 }, ['x']),
      'Stopped now: the approval it waited on was dropped. 1 waiting message was let go. Its schedule keeps running: x. The next tag starts it again.')
    assert.equal(stopLine({ refused: 'closed' }, ['x']), 'No session runs in this thread. Its schedule keeps running: x.')
    assert.equal(stopLine({ ok: true, ending: true, asking: true, dropped: 0 }, []), 'It waits on an approval, so it stops once that is answered. stop now cuts it. The next tag starts it again.')
    assert.equal(stopLine({ ok: true, dropped: 0 }, [], 1), 'Stopped. Its side lane stops too. The next tag starts it again.')
  })
})

describe('kage status summary, in Kage words', () => {
  test('the version, uptime, spend and schedules in one sentence', () => {
    const r = statusSummary({ version: '6185ff7 (2026-11-19, v0.4.3)', upSec: 6 * 3600, starts: startsSince('1 update\n2 restart\n', 0), schedules: 4, spentToday: 3.2, turnsToday: 12 })
    assert.equal(r.says, "I'm running 6185ff7. I've been up 6 hours and spent $3.20 today over 12 turns. 4 schedules. 2 starts in 24 h: 1 update, 1 restart, 0 crashes.")
    assert.equal(r.warn, undefined)
  })
  test("today's spend sits next to the 7-day daily average (#258)", () => {
    const r = statusSummary({ upSec: 3600, starts: startsSince('', 0), schedules: 0, spentToday: 84, turnsToday: 30, dailyAverage: 61 })
    assert.match(r.says, /spent \$84\.00 today over 30 turns, against a 7-day average of \$61\.00\./)
  })
  test('a crash or a stop with no cause is the warning, and planned restarts are not (#255)', () => {
    const base = { upSec: 60, schedules: 0, spentToday: 0, turnsToday: 0 }
    assert.equal(statusSummary({ ...base, starts: startsSince(Array.from({ length: 63 }, (_, i) => `${i + 1} update`).join('\n'), 0) }).warn, undefined)
    assert.equal(statusSummary({ ...base, starts: startsSince('1 crash boom\n2 unknown\n3 update\n', 0) }).warn, 'I crashed once and stopped once without saying why in the last 24 hours.')
    assert.equal(statusSummary({ ...base, starts: startsSince('1 crash boom\n2 crash boom\n', 0) }).warn, 'I crashed 2 times in the last 24 hours.')
  })
  test('one of each reads in the singular, and nothing spent says so', () => {
    assert.equal(statusSummary({ upSec: 3600, starts: startsSince('1 update\n', 0), schedules: 1, spentToday: 0, turnsToday: 0 }).says, "I've been up 1 hour and spent nothing today. 1 schedule.")
    assert.match(statusSummary({ upSec: 45, starts: startsSince('1 update\n', 0), schedules: 0, spentToday: 0, turnsToday: 0 }).says, /up 45 seconds/)
    assert.match(statusSummary({ upSec: 120, starts: startsSince('1 update\n', 0), schedules: 0, spentToday: 0, turnsToday: 0 }).says, /up 2 minutes/)
    assert.match(statusSummary({ upSec: 3 * 86400, starts: startsSince('1 update\n', 0), schedules: 0, spentToday: 0, turnsToday: 0 }).says, /up 3 days/)
  })
  test('an unknown stop is a warning, and an unknown uptime is left out', () => {
    const r = statusSummary({ starts: startsSince('1 unknown\n', 0), schedules: 0, spentToday: 0, turnsToday: 0 })
    assert.equal(r.says, "I'm running. I've spent nothing today.")
    assert.equal(r.warn, 'I stopped once without saying why in the last 24 hours.')
  })
})

describe('rows say what each thread is, and old ended sessions fold away (#257)', () => {
  test('the topic is the first ask, in up to 6 words, with the task tag and the sender line taken off', () => {
    const ask = '<channel source="kage" channel="C1" thread_ts="1.1" place="#eng">\nTask from Sam: check the default bot model providers that are enabled\ngrep for them in our docs'
    assert.equal(topicOf(ask), 'check the default bot model providers')
    assert.equal(topicOf('<channel source="kage" place="DM">\nTeammate task (U0AAA0001, Bo Test, not the owner): <@U0BBB0002> why is   the dialer slow?'), 'why is the dialer slow?')
    assert.equal(topicOf('<channel source="kage">\n'), undefined)
    assert.equal(topicOf('Scheduled check in #ops: count the open P1s'), 'count the open P1s')
    assert.equal(topicOf('<channel source="kage">\nScheduled run of job ea27ece0 (*/15 * * * *), set up earlier. Nobody wrote a new message.\nLead pipeline monitor for the sales team, read-only.'), 'Lead pipeline monitor for the sales')
    assert.equal(topicOf('<channel source="kage">\nTripwire of job ab12 (*/15 * * * *): the probe ran with no model and its output changed.\nBefore: MOBILE=443\nAfter: MOBILE=10\nPost when stock is low'), 'Post when stock is low')
    assert.equal(topicOf('<channel source="kage">\n</channel>'), undefined)
    assert.equal(topicOf('<channel source="kage">\nThis job started a new session. Its last posts, oldest first:\n> numbers are low\n> still low\nWatch the fresh number count'), 'Watch the fresh number count')
  })
  test('sessions that ended more than a day ago fold into one row, and opening it lists them', () => {
    const k = [...known('a', 'b'), ...['old1', 'old2', 'old3'].map(key => ({ key, place: `#${key}`, lastSeen: NOW - 2 * DAY, connector: 'slack' }))]
    const l = live({ live: [{ key: 'a', state: 'busy', quietMs: 1_000 }] })
    const folded = rows(k, l).rows
    assert.deepEqual(folded.map(r => r.key), ['a', 'b', FOLDED])
    assert.equal(folded.at(-1)!.place, '+3 ended earlier')
    const open = boardRows(k, l, new Map(), new Map(), NOW, true).rows
    assert.deepEqual(open.map(r => r.key), ['a', 'b', 'old1', 'old2', 'old3', FOLDED])
    assert.equal(open.at(-1)!.place, 'fold 3 ended')
  })
  test('a quiet live session is never folded, however old', () => {
    const k = [{ key: 'q', place: '#q', lastSeen: NOW - 3 * DAY, connector: 'slack' }]
    assert.deepEqual(rows(k, live({ live: [{ key: 'q', state: 'quiet', quietMs: 3 * DAY }] })).rows.map(r => r.key), ['q'])
  })
  test('each row carries its topic', () => {
    assert.equal(boardRows([{ ...known('a')[0]!, topic: 'count the open P1s' }], live(), new Map(), new Map(), NOW).rows[0]!.topic, 'count the open P1s')
  })
})

describe('kage status lists what each busy thread is doing (#258)', () => {
  const row = (key: string, state: Row['state'], topic?: string): Row => ({ key, place: `#${key}`, connector: 'slack', state, label: state === 'asking' ? 'asks you' : state, ageMs: 4 * MIN, ...topic && { topic } })
  test('working, starting, queued, held and asking threads show place, topic, age and the step they are on; quiet and ended ones do not', () => {
    const lines = liveThreadLines([row('a', 'working', 'count the open P1s'), row('b', 'asking', 'approve the refund'), row('c', 'quiet'), row('d', 'closed')], k => k === 'a' ? 'Bash  gh issue list' : 'reply  hi')
    assert.deepEqual(lines, ['working · #a · count the open P1s · 4m ago · Bash  gh issue list', 'asks you · #b · approve the refund · 4m ago'])
  })
  test('past the cap the rest are counted, so status stays short', () => {
    const many = Array.from({ length: 11 }, (_, i) => row(`t${i}`, 'working'))
    const lines = liveThreadLines(many, () => undefined, 8)
    assert.equal(lines.length, 9)
    assert.equal(lines.at(-1), '+3 more in kage top')
  })
})
