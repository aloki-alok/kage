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
  assert.deepEqual(await c.say(`here ${key}`), { ok: true, channel: 'X', ts: '9.9' })   // the DM with Kage is the owner's own
  await c.say('<!channel> look', { channel: 'CTEST2', thread_ts: '7.7' })
  assert.deepEqual(posts, [`here ${key}`, 'channel look'])
})
