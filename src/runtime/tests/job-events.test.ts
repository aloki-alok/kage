import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT, type Schedule } from '../../core/cron.ts'
import type { Trigger } from '../../core/tripwire.ts'
import type { ChannelHistory, ChannelPost } from '../channel-watch.ts'
import { jobEvents } from '../job-events.ts'
import type { Saved } from '../store.ts'

const memory = (): Saved => {
  const m = new Map<string, unknown>()
  return { load: n => m.get(n), save: (n, v) => void m.set(n, JSON.parse(JSON.stringify(v))) }
}
const job = (id: string, trigger: Trigger, key = 'CTEST1:1.1'): Schedule => ({ id, key, cron: EVENT, prompt: 'p', recurring: true, fromOwner: false, created: 0, lastFired: 0, lane: true, trigger })
const channelJob = (id: string, o: { match?: string; bots?: boolean; channel?: string } = {}) => job(id, { kind: 'channel', channel: o.channel ?? 'CTEST9', bots: o.bots ?? true, ...(o.match && { match: o.match }) })
const post = (ts: string, o: object = {}): ChannelPost => ({ channel: 'CTEST9', ts, text: `post ${ts}`, quoted: `> [bot ${ts}] post ${ts}`, bot: true, ...o })

function setup(jobs: Schedule[] = [], saved = memory()) {
  const woke: { id: string; quotes: string[] }[] = []
  const rows: string[] = []
  const pings: string[] = []
  const e = jobEvents({
    saved, schedules: () => jobs,
    wake: (id, quotes, x) => { woke.push({ id, quotes }); x?.ran?.(jobs.find(s => s.id === id)!, quotes.length) },
    track: (who, detail) => rows.push(`${who} ${detail}`),
    ping: (key, text) => pings.push(`${key} ${text}`),
    cfg: () => ({ patternMax: 50, maxPosts: 20, seenMax: 500 }),
  })
  return { e, jobs, woke, rows, pings, saved }
}
const history = (posts: ChannelPost[], o: { cap?: number; fail?: string[] } = {}) => {
  const asked: string[] = []
  const h: ChannelHistory = {
    newest: async c => posts.filter(p => p.channel === c).at(-1)?.ts,
    fetch: async (c, oldest) => {
      if (o.fail?.includes(c)) throw new Error('channel_not_found')
      const all = posts.filter(p => p.channel === c && Number(p.ts) > Number(oldest))
      asked.push(`${c} ${oldest}`)
      return { posts: all.slice(0, o.cap ?? 1000), truncated: all.length > (o.cap ?? 1000) }
    },
  }
  return { h, asked }
}

describe('a channel job', () => {
  test('an unsafe match is refused before anything is stored', () => {
    const t = setup()
    assert.match(t.e.refuse({ kind: 'channel', channel: 'CTEST9', bots: true, match: '(a+)+' })!, /nested quantifier/)
    assert.match(t.e.refuse({ kind: 'channel', channel: 'CTEST9', bots: true, match: 'x'.repeat(51) })!, /longer than 50/)
    assert.equal(t.e.refuse({ kind: 'channel', channel: 'CTEST9', bots: true, match: '^disk' }), undefined)
    assert.equal(t.e.refuse({ kind: 'hook', tokenHash: 'h' }), undefined)
  })

  test('a matching post wakes the job with the held post quoted, and writes a match and a wake row with ids only', () => {
    const t = setup([channelJob('j1', { match: '^post' })])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.e.channelPost(post('5.5'))
    assert.deepEqual(t.woke, [{ id: 'j1', quotes: ['> [bot 5.5] post 5.5'] }])
    assert.deepEqual(t.rows, ['CTEST1:1.1 match job=j1 channel=CTEST9 ts=5.5', 'CTEST1:1.1 wake job=j1 reason=channel n=1'])
    assert.equal(t.rows.some(r => r.includes('post 5.5')), false)
  })

  test('a post no job wants wakes nothing and writes nothing', () => {
    const t = setup([channelJob('j1', { match: 'cpu' })])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.e.channelPost(post('5.5'))
    t.e.channelPost(post('6.6', { channel: 'COTHER' }))
    assert.deepEqual([t.woke.length, t.rows.length], [0, 0])
  })

  test('a post for a job that was removed behind the watch is dropped and the watch cleaned', () => {
    const t = setup([channelJob('j1')])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.jobs.length = 0
    t.e.channelPost(post('5.5'))
    assert.equal(t.woke.length, 0)
    assert.deepEqual(t.e.watching(), [])
  })

  test('unscheduling removes the watch at once', () => {
    const t = setup([channelJob('j1')])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.e.stopped('j1')
    t.e.channelPost(post('5.5'))
    assert.equal(t.woke.length, 0)
  })
})

describe('catch-up', () => {
  test('a Slack reconnect gap: posts missed during it wake the job once each, and a post heard live and again in history wakes once', async () => {
    const t = setup([channelJob('j1')])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.e.channelGap()
    await t.e.channelCatchUp(history([post('1.1')]).h)
    assert.equal(t.woke.length, 0)
    t.e.channelPost(post('2.2'))
    t.e.channelGap()
    const later = [post('1.1'), post('2.2'), post('3.3'), post('4.4')]
    const up = t.e.channelCatchUp(history(later).h)
    t.e.channelPost(post('4.4'))
    await up
    assert.deepEqual(t.woke.flatMap(w => w.quotes).sort(), ['> [bot 2.2] post 2.2', '> [bot 3.3] post 3.3', '> [bot 4.4] post 4.4'])
    assert.ok(t.rows.includes('hub catchup channel=CTEST9 read=2 capped=false'), t.rows.join('\n'))
  })

  test('a capped catch-up asks again until the channel is read to the end, and each pass writes a row', async () => {
    const t = setup([channelJob('j1')])
    t.e.started('j1', t.jobs[0]!.trigger!)
    t.e.channelGap()
    await t.e.channelCatchUp(history([post('1.1')]).h)
    const posts = [post('1.1'), post('2.2'), post('3.3'), post('4.4'), post('5.5')]
    const h = history(posts, { cap: 2 })
    await t.e.channelCatchUp(h.h)
    assert.deepEqual(t.woke.flatMap(w => w.quotes).length, 4)
    assert.deepEqual(h.asked, ['CTEST9 1.1', 'CTEST9 3.3'])
    assert.deepEqual(t.rows.filter(r => r.includes('catchup')).slice(1), [
      'hub catchup channel=CTEST9 read=2 capped=true', 'hub catchup channel=CTEST9 read=2 capped=false',
    ])
  })

  test('a channel that fails writes an event and pings the job thread once as Kage, then again only after it recovered', async () => {
    const t = setup([channelJob('j1'), channelJob('j2', { channel: 'CTEST8' })])
    for (const j of t.jobs) t.e.started(j.id, j.trigger!)
    t.e.channelGap()
    await t.e.channelCatchUp(history([post('1.1'), post('1.1', { channel: 'CTEST8' })]).h)
    await t.e.channelCatchUp(history([post('1.1'), post('9.9')], { fail: ['CTEST9', 'CTEST8'] }).h)
    await t.e.channelCatchUp(history([post('1.1')], { fail: ['CTEST9', 'CTEST8'] }).h)
    assert.equal(t.pings.length, 2)
    assert.match(t.pings[0]!, /^CTEST1:1\.1 /)
    assert.ok(t.rows.includes('CTEST1:1.1 ping job=j1 fails=1'))
    assert.equal(t.rows.filter(r => r.startsWith('hub catchup') && r.endsWith('failed=1')).length, 4)
    await t.e.channelCatchUp(history([post('1.1')], { fail: ['CTEST8'] }).h)
    await t.e.channelCatchUp(history([post('1.1')], { fail: ['CTEST9', 'CTEST8'] }).h)
    assert.equal(t.pings.length, 3)
  })
})

describe('a hub restart', () => {
  test('watches are rebuilt from the stored triggers, a gap opens, and the catch-up wakes the job for posts missed while down', async () => {
    const jobs = [channelJob('j1', { match: '^post' }), job('h1', { kind: 'hook', tokenHash: 'x' })]
    const first = setup(jobs)
    first.e.rebuild()
    await first.e.channelCatchUp(history([post('1.1')]).h)
    const second = setup(jobs, memory())
    second.e.rebuild()
    assert.deepEqual(second.e.watching(), ['j1'])
    await second.e.channelCatchUp(history([post('1.1')]).h)
    second.e.channelGap()
    await second.e.channelCatchUp(history([post('1.1'), post('2.2')]).h)
    assert.deepEqual(second.woke.map(w => w.id), ['j1'])
  })

  test('the saved cursor survives, so a post missed while the hub was down wakes the job after the restart', async () => {
    const jobs = [channelJob('j1')]
    const saved = memory()
    const first = setup(jobs, saved)
    first.e.rebuild()
    await first.e.channelCatchUp(history([post('1.1')]).h)
    const second = setup(jobs, saved)
    second.e.rebuild()
    const h = history([post('1.1'), post('2.2')])
    await second.e.channelCatchUp(h.h)
    assert.deepEqual(h.asked, ['CTEST9 1.1'])
    assert.deepEqual(second.woke.flatMap(w => w.quotes), ['> [bot 2.2] post 2.2'])
  })

  test('a stored watch with no schedule left is dropped by the rebuild', () => {
    const saved = memory()
    const first = setup([channelJob('j1')], saved)
    first.e.started('j1', first.jobs[0]!.trigger!)
    const second = setup([], saved)
    second.e.rebuild()
    assert.deepEqual(second.e.watching(), [])
  })
})
