import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelHistory, channelWatches, pageAll, type ChannelHistory } from '../channel-watch.ts'
import type { Saved } from '../store.ts'

const memory = (): Saved => {
  const m = new Map<string, unknown>()
  return { load: n => m.get(n), save: (n, v) => void m.set(n, JSON.parse(JSON.stringify(v))) }
}
const post = (o: object = {}) => ({ channel: 'CTEST1', ts: '1.1', text: 'disk full', quoted: '> [other:bot 1.1] disk full', ...o })

test('a post wakes only the jobs whose channel and match fit', () => {
  const w = channelWatches(memory(), {})
  w.set('a', { channel: 'CTEST1', bots: true })
  w.set('b', { channel: 'CTEST1', match: '^disk', bots: true })
  w.set('c', { channel: 'CTEST1', match: 'cpu', bots: true })
  w.set('d', { channel: 'CTEST2', bots: true })
  assert.deepEqual(w.heard(post()).sort(), ['a', 'b'])
})

test('a bot post reaches a job only when the watch allows bots', () => {
  const w = channelWatches(memory(), {})
  w.set('open', { channel: 'CTEST1', bots: true })
  w.set('people', { channel: 'CTEST1', bots: false })
  assert.deepEqual(w.heard(post({ bot: true, app_id: 'ATEST1' })), ['open'])
  assert.deepEqual(w.heard(post({ ts: '2.2', user: 'UTEST1' })).sort(), ['open', 'people'])
})

test('take returns the quoted posts once, then nothing', () => {
  const w = channelWatches(memory(), {})
  w.set('a', { channel: 'CTEST1', bots: true })
  w.heard(post())
  w.heard(post({ ts: '2.2', quoted: '> second' }))
  assert.deepEqual(w.take('a'), ['> [other:bot 1.1] disk full', '> second'])
  assert.deepEqual(w.take('a'), [])
})

test('a job keeps only the newest posts up to the cap', () => {
  const w = channelWatches(memory(), { maxPosts: () => 2 })
  w.set('a', { channel: 'CTEST1', bots: true })
  for (const [i, n] of ['one', 'two', 'three'].entries()) w.heard(post({ ts: `${i + 2}.1`, quoted: n }))
  assert.deepEqual(w.take('a'), ['two', 'three'])
})

test('the cap defaults to 20', () => {
  const w = channelWatches(memory(), {})
  w.set('a', { channel: 'CTEST1', bots: true })
  for (let i = 0; i < 25; i++) w.heard(post({ ts: `${i + 2}.1`, quoted: String(i) }))
  assert.equal(w.take('a').length, 20)
})

test('remove stops a job hearing posts', () => {
  const w = channelWatches(memory(), {})
  w.set('a', { channel: 'CTEST1', bots: true })
  w.remove('a')
  assert.deepEqual(w.heard(post()), [])
})

test('watches survive a new instance on the same store', () => {
  const store = memory()
  channelWatches(store, {}).set('a', { channel: 'CTEST1', match: 'disk', bots: false })
  const again = channelWatches(store, {})
  assert.deepEqual(again.list(), { a: { channel: 'CTEST1', match: 'disk', bots: false } })
  assert.deepEqual(again.heard(post()), ['a'])
})

const history = (o: Partial<ChannelHistory> = {}): ChannelHistory => ({ fetch: async () => ({ posts: [], truncated: false }), newest: async () => '10.1', ...o })
const baselined = async (store = memory(), o: Parameters<typeof channelWatches>[1] = {}) => {
  const w = channelWatches(store, o)
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history())
  return w
}

test('a repeated ts counts once, and a post nobody watches is ignored', () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  assert.deepEqual(w.heard(post({ ts: '10.5' })), ['a'])
  assert.deepEqual(w.heard(post({ ts: '10.5' })), [])
  assert.deepEqual(w.heard(post({ channel: 'CTEST9', ts: '11.1' })), [])
  assert.equal(w.take('a').length, 1)
})

test('Slack sending an older ts again, after newer ones, is heard once', () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  w.heard(post({ ts: '12.1', quoted: 'p12' }))
  assert.deepEqual(w.heard(post({ ts: '11.1', quoted: 'p11' })), ['a'])
  assert.deepEqual(w.heard(post({ ts: '11.1', quoted: 'p11' })), [])
  assert.deepEqual(w.take('a'), ['p12', 'p11'])
})

test('the seen set is bounded: the oldest ts is forgotten past seenMax', () => {
  const w = channelWatches(memory(), { seenMax: () => 2 })
  w.set('a', { channel: 'CTEST1', bots: true })
  for (const ts of ['1.1', '2.1', '3.1']) w.heard(post({ ts }))
  assert.deepEqual(w.heard(post({ ts: '3.1' })), [])
  assert.deepEqual(w.heard(post({ ts: '1.1' })), ['a'])
})

test('a live post that lands during the history fetch does not hide the older missed posts', async () => {
  const w = await baselined()
  w.gapOpened()
  w.heard(post({ ts: '10.1', quoted: 'p10' }))
  await w.catchUp(history({ fetch: async () => {
    w.heard(post({ ts: '13.1', quoted: 'p13' }))
    return { posts: [post({ ts: '12.1', quoted: 'p12' }), post({ ts: '11.1', quoted: 'p11' })], truncated: false }
  } }))
  assert.deepEqual(w.take('a').sort(), ['p10', 'p11', 'p12', 'p13'])
})

test('catch-up reads from the cursor, delivers oldest first, skips what was heard live, and moves the cursor', async () => {
  const w = await baselined()
  w.gapOpened()
  w.heard(post({ ts: '11.1', quoted: 'live' }))
  const asked: string[] = []
  const fetch = async (_c: string, oldest: string) => {
    asked.push(oldest)
    return { posts: [post({ ts: '12.1', quoted: 'late' }), post({ ts: '11.1', quoted: 'live' }), post({ ts: '10.5', quoted: 'missed' })], truncated: false }
  }
  await w.catchUp(history({ fetch }))
  await w.catchUp(history({ fetch }))
  assert.deepEqual(asked, ['10.1', '12.1'])
  assert.deepEqual(w.take('a'), ['live', 'missed', 'late'])
})

test('the first baseline is the newest ts Slack returns, not the hub clock', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  let fetchedFrom = ''
  await w.catchUp(history({ newest: async () => '7.2' }))
  await w.catchUp(history({ fetch: async (_c, o) => { fetchedFrom = o; return { posts: [post({ ts: '8.1', quoted: 'next' })], truncated: false } } }))
  assert.equal(fetchedFrom, '7.2')
  assert.deepEqual(w.take('a'), ['next'])
})

test('cursor and seen ts survive a new instance on the same store', async () => {
  const store = memory()
  const w = await baselined(store)
  w.gapOpened()
  w.heard(post({ ts: '11.1' }))
  let from = ''
  const again = channelWatches(store)
  await again.catchUp(history({ fetch: async (_c, o) => { from = o; return { posts: [post({ ts: '11.1' })], truncated: false } } }))
  assert.equal(from, '10.1')
  assert.deepEqual(again.take('a'), [])
})

test('one channel failing is returned and the others still catch up', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  w.set('b', { channel: 'CTEST2', bots: true })
  await w.catchUp(history())
  const boom = new Error('ratelimited')
  const r = await w.catchUp(history({ fetch: async channel => {
    if (channel === 'CTEST1') throw boom
    return { posts: [post({ channel, ts: '11.1', quoted: 'got' })], truncated: true }
  } }))
  assert.deepEqual(r, [{ channel: 'CTEST1', truncated: false, error: boom }, { channel: 'CTEST2', truncated: true }])
  assert.deepEqual(w.take('b'), ['got'])
})

test('a failed catch-up leaves the cursor, so the next one covers the same posts', async () => {
  const w = await baselined()
  await w.catchUp(history({ fetch: async () => { throw new Error('down') } }))
  let from = ''
  await w.catchUp(history({ fetch: async (_c, o) => { from = o; return { posts: [], truncated: false } } }))
  assert.equal(from, '10.1')
})

test('a bad regex is refused at set and the old watch stays', () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', match: 'disk', bots: true })
  assert.throws(() => w.set('a', { channel: 'CTEST1', match: '[', bots: true }), /match/)
  assert.equal(w.list().a?.match, 'disk')
})

test('pageAll follows the cursor through every page and says nothing was cut', async () => {
  const pages = [{ items: [3, 2], next: 'c2' }, { items: [1] }]
  const cursors: (string | undefined)[] = []
  const r = await pageAll(async c => { cursors.push(c); return pages[cursors.length - 1]! }, 10)
  assert.deepEqual(r, { items: [3, 2, 1], truncated: false })
  assert.deepEqual(cursors, [undefined, 'c2'])
})

test('pageAll stops at the cap and flags it', async () => {
  const r = await pageAll(async () => ({ items: [3, 2], next: 'more' }), 3)
  assert.deepEqual(r, { items: [3, 2, 3], truncated: true })
})

test('channelHistory pages conversations.history from the cursor and keeps the posts toPosts accepts', async () => {
  const calls: object[] = []
  const pages = [{ messages: [{ ts: '3.1' }, { ts: '2.1', skip: true }], response_metadata: { next_cursor: 'c2' } }, { messages: [{ ts: '1.1' }], response_metadata: { next_cursor: '' } }]
  const h = channelHistory(async a => (calls.push(a), pages[calls.length - 1]!), 10, (m, channel) => (m as { skip?: boolean }).skip ? [] : [post({ channel, ts: (m as { ts: string }).ts })])
  const r = await h.fetch('CTEST1', '1.0')
  assert.deepEqual(r.posts.map(p => p.ts), ['1.1', '3.1'])
  assert.equal(r.truncated, false)
  assert.deepEqual(calls, [{ channel: 'CTEST1', oldest: '1.0', limit: 200 }, { channel: 'CTEST1', oldest: '1.0', limit: 200, cursor: 'c2' }])
})

test('a failing history page fails the fetch, and catch-up reports it for that channel', async () => {
  const h = channelHistory(async () => { throw new Error('rate_limited') }, 10, () => [])
  const w = await baselined()
  const [r] = await w.catchUp(h)
  assert.match(String((r!.error as Error).message), /rate_limited/)
})

test('channelHistory asks for one message to find the newest ts, and says none for an empty channel', async () => {
  const asked: object[] = []
  const h = (messages: object[]) => channelHistory(async a => (asked.push(a), { messages }), 10, () => [])
  assert.equal(await h([{ ts: '9.9' }]).newest('CTEST1'), '9.9')
  assert.equal(await h([]).newest('CTEST1'), undefined)
  assert.deepEqual(asked[0], { channel: 'CTEST1', limit: 1 })
})

const upTo = (n: number): ChannelHistory => history({ fetch: async (channel, oldest) => ({
  posts: Array.from({ length: n }, (_, i) => post({ channel, ts: `${i + 1}.1`, quoted: `p${i + 1}` })).filter(p => Number(p.ts) > Number(oldest)), truncated: false }) })

test('after a long healthy stretch, catch-up reads only from the last live post', async () => {
  const w = channelWatches(memory(), { seenMax: () => 500 })
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => '0.1' }))
  for (let i = 1; i <= 600; i++) w.heard(post({ ts: `${i}.1`, quoted: `p${i}` }))
  w.take('a')
  await w.catchUp(upTo(600))
  assert.deepEqual(w.take('a'), [])
})

test('after a gap opens, live posts leave the cursor and the missed ones are still caught', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => '1.1' }))
  w.heard(post({ ts: '2.1', quoted: 'p2' }))
  w.gapOpened()
  w.heard(post({ ts: '5.1', quoted: 'p5' }))
  await w.catchUp(upTo(5))
  assert.deepEqual(w.take('a').sort(), ['p2', 'p3', 'p4', 'p5'])
})

test('a failed catch-up keeps the gap open', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => '1.1' }))
  w.gapOpened()
  await w.catchUp(history({ fetch: async () => { throw new Error('down') } }))
  w.heard(post({ ts: '5.1', quoted: 'p5' }))
  await w.catchUp(upTo(5))
  assert.deepEqual(w.take('a').sort(), ['p2', 'p3', 'p4', 'p5'])
})

test('match is compiled when the watch is set, not on each post', () => {
  const Real = globalThis.RegExp
  let built = 0
  globalThis.RegExp = class extends Real { constructor(p: string | RegExp, f?: string) { super(p, f); built++ } } as RegExpConstructor
  try {
    const w = channelWatches(memory())
    w.set('a', { channel: 'CTEST1', match: 'disk', bots: true })
    const atSet = built
    for (const ts of ['1.1', '2.1', '3.1']) w.heard(post({ ts }))
    assert.equal(built, atSet)
  } finally { globalThis.RegExp = Real }
})

test('a gap that opens during a catch-up is not closed by it', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  w.set('b', { channel: 'CTEST2', bots: true })
  await w.catchUp(history({ newest: async () => '1.1' }))
  w.gapOpened()
  await w.catchUp(history({ fetch: async channel => {
    if (channel === 'CTEST1') w.gapOpened()
    return { posts: [], truncated: false }
  } }))
  w.heard(post({ channel: 'CTEST2', ts: '9.1', quoted: 'live' }))
  const asked: string[] = []
  await w.catchUp(history({ fetch: async (channel, oldest) => (asked.push(`${channel}@${oldest}`), { posts: [], truncated: false }) }))
  assert.deepEqual(asked, ['CTEST1@1.1', 'CTEST2@1.1'])
})

const slackWith = (n: number) => async (a: { channel: string; oldest?: string; cursor?: string; limit: number }) => {
  const all = Array.from({ length: n }, (_, i) => ({ ts: `${n - i}.1` })).filter(m => Number(m.ts) > Number(a.oldest ?? 0))
  const from = Number(a.cursor ?? 0)
  const messages = all.slice(from, from + a.limit)
  return { messages, response_metadata: { next_cursor: from + a.limit < all.length ? String(from + a.limit) : '' } }
}

test('a capped catch-up delays the rest and never drops it: oldest first, nothing twice', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => '0.1' }))
  w.gapOpened()
  const h = channelHistory(slackWith(7), 3, (m, channel) => [post({ channel, ts: (m as { ts: string }).ts, quoted: (m as { ts: string }).ts })])
  const runs: boolean[] = []
  for (let i = 0; i < 5 && runs.at(-1) !== false; i++) runs.push((await w.catchUp(h))[0]!.truncated)
  assert.deepEqual(runs, [true, true, false])
  assert.deepEqual(w.take('a'), ['1.1', '2.1', '3.1', '4.1', '5.1', '6.1', '7.1'])
})

test('a live post during a capped catch-up does not skip the posts still waiting', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => '0.1' }))
  w.gapOpened()
  const h = channelHistory(slackWith(7), 3, (m, channel) => [post({ channel, ts: (m as { ts: string }).ts, quoted: (m as { ts: string }).ts })])
  await w.catchUp(h)
  w.heard(post({ ts: '9.1', quoted: 'live' }))
  await w.catchUp(h)
  assert.deepEqual(w.take('a'), ['1.1', '2.1', '3.1', 'live', '4.1', '5.1', '6.1'])
})

test('heard, catchUp and take work when passed on detached', async () => {
  const { set, heard, catchUp, take } = channelWatches(memory())
  set('a', { channel: 'CTEST1', bots: true })
  await catchUp(history({ newest: async () => '1.1' }))
  assert.deepEqual(await catchUp(history({ fetch: async () => ({ posts: [post({ ts: '2.1', quoted: 'x' })], truncated: false }) })), [{ channel: 'CTEST1', truncated: false }])
  assert.deepEqual(heard(post({ ts: '3.1' })), ['a'])
  assert.equal(take('a').length, 2)
})

test('a gap that opens during the first baseline is not closed by it, so a live post leaves the cursor', async () => {
  const w = channelWatches(memory())
  w.set('a', { channel: 'CTEST1', bots: true })
  await w.catchUp(history({ newest: async () => { w.gapOpened(); return '1.1' } }))
  w.heard(post({ ts: '9.1', quoted: 'live' }))
  const asked: string[] = []
  await w.catchUp(history({ fetch: async (channel, oldest) => (asked.push(`${channel}@${oldest}`), { posts: [], truncated: false }) }))
  assert.deepEqual(asked, ['CTEST1@1.1'])
})

test('a catch-up that returns only posts older than the cursor leaves the cursor where it was', async () => {
  const w = await baselined()
  w.gapOpened()
  await w.catchUp(history({ fetch: async () => ({ posts: [post({ ts: '9.1', quoted: 'old' })], truncated: false }) }))
  const asked: string[] = []
  await w.catchUp(history({ fetch: async (_c, oldest) => (asked.push(oldest), { posts: [], truncated: false }) }))
  assert.deepEqual(asked, ['10.1'])
})

test('a channel no job watches any more is not read, and remove drops the posts its job had waiting', async () => {
  const w = await baselined()
  w.heard(post({ ts: '11.1', quoted: 'waiting' }))
  w.remove('a')
  assert.deepEqual(w.take('a'), [])
  const asked: string[] = []
  await w.catchUp(history({ fetch: async (channel, oldest) => (asked.push(`${channel}@${oldest}`), { posts: [], truncated: false }) }))
  assert.deepEqual(asked, [])
})
