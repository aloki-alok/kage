import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionKey, sessionKey, slackConversation, type Conversation } from './conversations.ts'

const DM = 'DBOT00001'

describe('where a Slack message lives', () => {
  test('a top-level message starts its own thread, and its replies share it', () => {
    const top = slackConversation({ channel: 'C1', ts: '5.5', channel_type: 'channel' }, DM)
    const reply = slackConversation({ channel: 'C1', ts: '6.6', thread_ts: '5.5', channel_type: 'channel' }, DM)
    assert.deepEqual(top, { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' })
    assert.deepEqual(reply, top)
  })
  test("the top level of the owner's DM with the agent is one rolling conversation; a thread in it is its own", () => {
    assert.deepEqual(slackConversation({ channel: DM, ts: '1.1', channel_type: 'im' }, DM), { connector: 'slack', chat: DM, kind: 'dm', agentDm: true })
    assert.deepEqual(slackConversation({ channel: DM, ts: '3.3', thread_ts: '1.1', channel_type: 'im' }, DM), { connector: 'slack', chat: DM, thread: '1.1', kind: 'dm' })
  })
  test('DMs, group DMs and channels are told apart', () => {
    assert.equal(slackConversation({ channel: 'D9', ts: '1.1', channel_type: 'im' }, DM).kind, 'dm')
    assert.equal(slackConversation({ channel: 'C9', ts: '1.1', channel_type: 'mpim' }, DM).kind, 'group')
    assert.equal(slackConversation({ channel: 'C9', ts: '1.1', channel_type: 'group' }, DM).kind, 'channel')
  })
})

describe('the key of the session working on a conversation', () => {
  const slack: Conversation = { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' }
  test("Kage's keys stay exactly as before, so every existing thread resumes its own session", () => {
    assert.equal(sessionKey(slack), 'C1:5.5')
    assert.equal(sessionKey({ connector: 'slack', chat: DM, kind: 'dm', agentDm: true }), 'dm')
    assert.equal(sessionKey({ connector: 'slack', chat: DM, thread: '1.1', kind: 'dm' }), `${DM}:1.1`)
    assert.equal(sessionKey({ connector: 'email', chat: '<root@x>', kind: 'mail' }), 'mail:<root@x>')
    assert.equal(sessionKey({ connector: 'whatsapp', chat: '100000000000001@lid', kind: 'chat' }), 'wa:100000000000001@lid')
    assert.equal(sessionKey({ connector: 'voice', chat: 'abc-123', kind: 'chat' }), 'voice:abc-123')
  })
  test('a side lane gets its own session on the same conversation', () => {
    assert.equal(sessionKey(slack, { lane: 'side-6.6' }), 'C1:5.5#side-6.6')
  })
  test('another agent on the same conversation gets its own session', () => {
    assert.equal(sessionKey(slack, { agent: 'ops' }), 'ops/C1:5.5')
    assert.equal(sessionKey(slack, { agent: 'ops', lane: 'side-6.6' }), 'ops/C1:5.5#side-6.6')
    assert.notEqual(sessionKey(slack, { agent: 'ops' }), sessionKey(slack))
  })
  test('a key reads back into the same agent, conversation and lane', () => {
    for (const [c, o] of [
      [slack, {}], [slack, { lane: 'side-6.6' }], [slack, { agent: 'ops', lane: 'side-6.6' }],
      [{ connector: 'slack', chat: DM, kind: 'dm', agentDm: true }, {}],
      [{ connector: 'email', chat: '<a:b@c>', kind: 'mail' }, {}],
      [{ connector: 'whatsapp', chat: '91999@c.us', kind: 'chat' }, { agent: 'ops' }],
      [{ connector: 'voice', chat: 'abc-123', kind: 'chat' }, {}],
    ] as [Conversation, { agent?: string; lane?: `side-${string}` }][]) {
      const k = sessionKey(c, o)
      const back = parseSessionKey(k, DM)
      assert.ok(back, k)
      assert.equal(sessionKey(back.conversation, { agent: back.agent, lane: back.lane }), k)
      assert.equal(back.conversation.connector, c.connector)
      assert.equal(back.conversation.chat, c.chat)
    }
  })
  test('a key that is not one of these shapes reads back as nothing', () => {
    for (const k of ['', 'C1', 'nope:x', 'ops/', 'C1:5.5#lane-x']) assert.equal(parseSessionKey(k), undefined, k)
  })
})
