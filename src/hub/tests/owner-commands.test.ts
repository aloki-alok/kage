import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownerCommands } from '../owner-commands.ts'

test("kage say posts a new message to the DM with Kage, and a reply only into the DM or a thread Kage works in", async () => {
  const posts: unknown[] = []
  const threads: Record<string, { kind: string }> = { 'CTEST2:7.7': { kind: 'group' } }
  const c = ownerCommands({
    store: { conversation: (key: string) => threads[key] && { conversation: threads[key] } }, botDm: 'DTEST',
    post: async (text: string, at?: object) => { posts.push([text, at]); return { channel: 'X', ts: '9.9' } },
  } as never)
  assert.deepEqual(await c.say('hi'), { ok: true, channel: 'X', ts: '9.9' })
  assert.deepEqual(await c.say('more', { channel: 'DTEST', thread_ts: '1.1' }), { ok: true, channel: 'X', ts: '9.9' })
  assert.deepEqual(await c.say('and?', { channel: 'CTEST2', thread_ts: '7.7' }), { ok: true, channel: 'X', ts: '9.9' })
  assert.deepEqual(await c.say('psst', { channel: 'CTEST3', thread_ts: '7.7' }), { refused: 'Kage has no thread there' })
  assert.deepEqual(posts, [['hi', undefined], ['more', { channel: 'DTEST', thread_ts: '1.1', kind: 'dm' }], ['and?', { channel: 'CTEST2', thread_ts: '7.7', kind: 'group' }]])
})

test('a failed Slack post comes back as a refusal with its reason', async () => {
  const c = ownerCommands({ store: {}, botDm: 'DTEST', post: async () => { throw Object.assign(new Error('x'), { data: { error: 'channel_not_found' } }) } } as never)
  assert.deepEqual(await c.say('hi'), { refused: 'Slack refused the post: channel_not_found' })
})

test('kage say keeps the outbound rules: no secret into a shared thread, no crowd ping', async () => {
  const posts: string[] = []
  const c = ownerCommands({
    store: { conversation: () => ({ conversation: { kind: 'channel' } }) }, botDm: 'DTEST',
    post: async (text: string) => { posts.push(text); return { channel: 'X', ts: '9.9' } },
  } as never)
  const key = 'xoxb-1234567890-abcdefghij'
  assert.deepEqual(await c.say(`here ${key}`, { channel: 'CTEST2', thread_ts: '7.7' }), { refused: 'this looks like a Slack token, and a thread is seen by others. Send it in the DM with Kage instead' })
  assert.deepEqual(await c.say(`here ${key}`), { ok: true, channel: 'X', ts: '9.9' })
  await c.say('<!channel> look', { channel: 'CTEST2', thread_ts: '7.7' })
  assert.deepEqual(posts, [`here ${key}`, 'channel look'])
})

type Pause = { until: number; held: number; draining?: true } | undefined
function owner(o: { result?: string; paused?: Pause; threads?: Record<string, { connector: string; chat: string; thread?: string; kind: string }> } = {}) {
  const calls: string[] = [], relay = new Set<string>(['CTEST1:1.1'])
  let paused = o.paused
  const threads = o.threads ?? { 'CTEST1:1.1': { connector: 'slack', chat: 'CTEST1', thread: '1.1', kind: 'channel' }, 'wa:1': { connector: 'whatsapp', chat: '1', kind: 'chat' } }
  const c = ownerCommands({
    d: {
      task: (key: string) => { calls.push(`task ${key}`); return o.result ?? 'sent' },
      status: () => ({ live: [{ key: 'CTEST1:1.1', state: 'quiet', quietMs: 300_000 }, { key: 'CTEST2:2.2', state: 'busy', quietMs: 0 }], waiting: ['CTEST3:3.3'], held: ['CTEST4:4.4'] }),
    },
    store: {
      conversation: (key: string) => threads[key] && { conversation: threads[key], place: `#${key}` },
      setRelayAllow: (key: string, on: boolean) => { if (on) relay.add(key); else relay.delete(key) },
      relayAllowed: () => [...relay],
      threadsIn: (chat: string) => Object.keys(threads).filter(k => threads[k]!.connector === 'slack' && threads[k]!.chat === chat && !k.includes('#')),
    },
    ledgers: { text: () => `2026-11-01T00:00:00.000Z\topen\tCTEST1:1.1\t\tq1\n` },
    limits: { paused: () => paused, counts: { limitHits: 0 } }, MAX: 4, placeOf: (k: string) => `#${k}`,
    closedTo: (key: string) => calls.push(`closed ${key}`), noteTrust: (key: string) => calls.push(`trust ${key}`),
    failed: () => calls.push('failed'), dropRelay: (key: string) => calls.push(`drop ${key}`), botDm: 'DTEST', post: async () => ({ channel: 'X', ts: '1' }),
  } as never)
  return { c, calls, relay, pause: (p: Pause) => { paused = p } }
}

test('kage status lists live, waiting and held sessions, the open questions, and a pause first', () => {
  const t = owner()
  assert.equal(t.c.status(), ['*2 of 4 sessions*, 1 waiting for a slot', '• #CTEST1:1.1: quiet for 5 min', '• #CTEST2:2.2: busy', '• #CTEST3:3.3: waiting for a slot',
    '• #CTEST4:4.4: open in your terminal (kage thread attach), tasks wait', '1 question waiting on you'].join('\n'))
  t.pause({ until: 0, held: 0, draining: true })
  assert.match(t.c.status(), /^\*Stopping for a restart or a stop/)
})

test('kage thread send reaches only a known Slack thread, never while paused, and says when the thread is held or the session fails', () => {
  assert.deepEqual(owner().c.tell('CTEST9:9.9', 'x'), { refused: 'no thread with that key' })
  assert.deepEqual(owner().c.tell('wa:1', 'x'), { refused: 'tell works on Slack threads only for now' })
  assert.match((owner({ paused: { until: 0, held: 0, draining: true } }).c.tell('CTEST1:1.1', 'x') as { refused: string }).refused, /^Kage is stopping for a restart or a stop, so it would be lost/)
  const t = owner()
  assert.deepEqual(t.c.tell('CTEST1:1.1', 'x'), { ok: true })
  assert.deepEqual(t.calls, ['closed CTEST1:1.1', 'trust CTEST1:1.1', 'task CTEST1:1.1'])
  assert.deepEqual(owner({ result: 'held' }).c.tell('CTEST1:1.1', 'x'), { ok: true, held: true })
  const f = owner({ result: 'failed' })
  assert.deepEqual(f.c.tell('CTEST1:1.1', 'x'), { refused: 'could not start a session there' })
  assert.equal(f.calls.at(-1), 'failed')
})

test('kage relay takes only a plain Slack thread key, allows only a known thread, and a deny drops the relay', () => {
  const t = owner()
  assert.deepEqual(t.c.relay('allow', 'CTEST1:1.1#side-x'), { refused: 'that is not a Slack thread key or channel id (a lane or a whole DM is never listed)' })
  assert.deepEqual(t.c.relay('allow', 'wa:1'), { refused: 'that is not a Slack thread key or channel id (a lane or a whole DM is never listed)' })
  assert.deepEqual(t.c.relay('allow', 'CTEST9:9.9'), { refused: 'no thread with that key' })
  assert.deepEqual(t.c.relay('deny', 'CTEST1:1.1'), { ok: true, keys: [] })
  assert.deepEqual(t.calls, ['drop CTEST1:1.1'])
  assert.deepEqual(t.c.relay('list'), { ok: true, keys: [] })
})

test('kage relay takes a channel Kage has a thread in, never a DM, and a channel deny drops each of its threads', () => {
  const t = owner({ threads: { 'CTEST1:1.1': { connector: 'slack', chat: 'CTEST1', thread: '1.1', kind: 'channel' }, 'CTEST1:2.2': { connector: 'slack', chat: 'CTEST1', thread: '2.2', kind: 'channel' }, 'DTEST1:3.3': { connector: 'slack', chat: 'DTEST1', thread: '3.3', kind: 'dm' } } })
  assert.deepEqual(t.c.relay('allow', 'CTEST9'), { refused: 'Kage has no thread in that channel' })
  assert.deepEqual(t.c.relay('allow', 'DTEST1'), { refused: 'that is not a Slack thread key or channel id (a lane or a whole DM is never listed)' })
  assert.deepEqual(t.c.relay('allow', 'CTEST1'), { ok: true, keys: ['CTEST1:1.1', 'CTEST1'] })
  assert.deepEqual(t.c.relay('deny', 'CTEST1:1.1'), { refused: 'its whole channel CTEST1 is listed, so deny the channel instead' })
  assert.deepEqual(t.c.relay('deny', 'CTEST1'), { ok: true, keys: ['CTEST1:1.1'] })
  assert.deepEqual(t.calls, ['drop CTEST1:1.1', 'drop CTEST1:2.2'])
})
