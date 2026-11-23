import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isJobLane, jobLane, modelFor, matchThreads, threadOfJobLane, parseSessionKey, placeFor, sessionKey, slackConversation, slackLinkKey, type Conversation } from '../conversations.ts'

const DM = 'DBOT00001'

describe('where a Slack message lives', () => {
  test('a top-level message starts its own thread, and its replies share it', () => {
    const top = slackConversation({ channel: 'C1', ts: '5.5', channel_type: 'channel' }, DM, () => false)
    const reply = slackConversation({ channel: 'C1', ts: '6.6', thread_ts: '5.5', channel_type: 'channel' }, DM, () => false)
    assert.deepEqual(top, { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' })
    assert.deepEqual(reply, top)
  })
  test("the top level of the owner's DM with the agent is one rolling conversation; a thread under a Kage post is its own", () => {
    const kagePosted = (ts: string) => ts === '2.2'
    assert.deepEqual(slackConversation({ channel: DM, ts: '1.1', channel_type: 'im' }, DM, kagePosted), { connector: 'slack', chat: DM, kind: 'dm', agentDm: true })
    assert.deepEqual(slackConversation({ channel: DM, ts: '3.3', thread_ts: '2.2', channel_type: 'im' }, DM, kagePosted), { connector: 'slack', chat: DM, thread: '2.2', kind: 'dm' })
  })
  test("a reply under the owner's own top-level DM joins the rolling conversation, so no second session redoes that ask", () => {
    const reply = slackConversation({ channel: DM, ts: '3.3', thread_ts: '1.1', channel_type: 'im' }, DM, () => false)
    assert.equal(sessionKey(reply), 'dm')
  })
  test('DMs, group DMs and channels are told apart', () => {
    assert.equal(slackConversation({ channel: 'D9', ts: '1.1', channel_type: 'im' }, DM, () => false).kind, 'dm')
    assert.equal(slackConversation({ channel: 'C9', ts: '1.1', channel_type: 'mpim' }, DM, () => false).kind, 'group')
    assert.equal(slackConversation({ channel: 'C9', ts: '1.1', channel_type: 'group' }, DM, () => false).kind, 'channel')
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
  test('a bare connector prefix with no id is not a key', () => {
    for (const k of ['mail:', 'wa:', 'voice:']) assert.equal(parseSessionKey(k, DM), undefined)
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

test('a side lane or another agent shows its conversation\'s place', () => {
  const places = new Map([['C1:5.5', '#ops']])
  assert.equal(placeFor(k => places.get(k), 'C1:5.5'), '#ops')
  assert.equal(placeFor(k => places.get(k), 'C1:5.5#side-6.6'), '#ops (side)')
  assert.equal(placeFor(k => places.get(k), 'ops/C1:5.5'), '#ops')
  assert.equal(placeFor(k => places.get(k), 'C9:1.1'), 'C9:1.1')
})

describe('the session key a pasted Slack link points at', () => {
  test('a link to a message is the thread that message starts', () => {
    assert.equal(slackLinkKey('https://test.slack.com/archives/CTEST1/p1700000000123456'), 'CTEST1:1700000000.123456')
  })
  test('a link to a reply is the thread it sits in', () => {
    assert.equal(slackLinkKey('https://test.slack.com/archives/CTEST1/p1700000005000200?thread_ts=1700000000.123456&cid=CTEST1'), 'CTEST1:1700000000.123456')
  })
  test('a link the shell cut at "&", or pasted with spaces around it, still works', () => {
    assert.equal(slackLinkKey('  https://test.slack.com/archives/CTEST1/p1700000005000200?thread_ts=1700000000.123456\n'), 'CTEST1:1700000000.123456')
  })
  test('a place name, another site or a link with no message is not a link', () => {
    for (const s of ['general', 'DM with Kage', 'CTEST1:1700000000.123456', 'https://test.slack.com/archives/CTEST1',
      'https://example.com/archives/CTEST1/p1700000000123456', 'https://slack.com.example.com/archives/CTEST1/p1700000000123456',
      'https://test.slack.com/archives/CTEST1/p1700000005000200?thread_ts=nope']) {
      assert.equal(slackLinkKey(s), undefined, s)
    }
  })
})

describe('finding a thread by what you typed, for kage attach, tell and stop', () => {
  const rows = [
    { key: 'CTEST1:1700000000.123456', place: '#support', chat: 'CTEST1', agent_dm: null },
    { key: 'CTEST1:1700000000.123456#side-1', place: '#support (side)', chat: 'CTEST1', agent_dm: null },
    { key: 'CTEST2:1700000001.000001', place: '#Deploys', chat: 'CTEST2', agent_dm: null },
    { key: 'dm', place: 'DM with Kage', chat: 'DTEST1', agent_dm: 1 },
  ]
  test('by part of the place, any case, or by the exact key', () => {
    assert.deepEqual(matchThreads(rows, 'deploys').map(r => r.key), ['CTEST2:1700000001.000001'])
    assert.deepEqual(matchThreads(rows, 'support').length, 2)
    assert.deepEqual(matchThreads(rows, 'dm').map(r => r.key), ['dm'])
  })
  test('an exact key wins over places that only contain it', () => {
    const more = [...rows, { key: 'DTEST1:1700000002.000001', place: 'DM with Kage', chat: 'DTEST1', agent_dm: 1 }]
    assert.deepEqual(matchThreads(more, 'dm').map(r => r.key), ['dm'])
    assert.deepEqual(matchThreads(more, 'DM with').length, 2)
  })
  test('by a Slack link: the thread and its side lanes; a top-level DM message finds the one DM session', () => {
    assert.deepEqual(matchThreads(rows, 'https://test.slack.com/archives/CTEST1/p1700000000123456').map(r => r.key),
      ['CTEST1:1700000000.123456', 'CTEST1:1700000000.123456#side-1'])
    assert.deepEqual(matchThreads(rows, 'https://test.slack.com/archives/DTEST1/p1700000009000000').map(r => r.key), ['dm'])
    assert.deepEqual(matchThreads(rows, 'https://test.slack.com/archives/CTEST9/p1700000009000000'), [])
  })
  test('nothing typed matches nothing', () => assert.deepEqual(matchThreads(rows, ''), []))
})

test('a job lane is the thread key plus the job id, and its thread is found by stripping it', () => {
  assert.equal(jobLane('C1:5.5', 'j1'), 'C1:5.5#side-job-j1')
  assert.equal(jobLane('C1:5.5#side-kagelet-ops', 'j1'), 'C1:5.5#side-kagelet-ops')
  assert.equal(threadOfJobLane('C1:5.5#side-job-j1'), 'C1:5.5')
  assert.equal(threadOfJobLane('C1:5.5#side-6.6'), 'C1:5.5#side-6.6')
  assert.equal(isJobLane('ops/C1:5.5#side-job-j1'), true)
  assert.equal(isJobLane('C1:5.5'), false)
})

test('a job lane runs on harness.jobModel, or the sessions\' own model when unset; any other key asks its own rule', () => {
  const other = (k: string) => `other:${k}`
  assert.equal(modelFor('C1:5.5#side-job-j1', 'haiku', other), 'haiku')
  assert.equal(modelFor('C1:5.5#side-job-j1', undefined, other), undefined)
  assert.equal(modelFor('C1:5.5#side-job-j1', '', other), undefined)
  assert.equal(modelFor('C1:5.5', 'haiku', other), 'other:C1:5.5')
})

test('a job lane runs on its own schedule\'s model first, then harness.jobModel', () => {
  const other = (k: string) => `other:${k}`
  const own = (id: string) => (id === 'j1' ? 'haiku' : undefined)
  assert.equal(modelFor('C1:5.5#side-job-j1', 'sonnet', other, own), 'haiku')
  assert.equal(modelFor('ops/C1:5.5#side-job-j1', undefined, other, own), 'haiku')
  assert.equal(modelFor('C1:5.5#side-job-j2', 'sonnet', other, own), 'sonnet')
  assert.equal(modelFor('C1:5.5#side-job-j2', undefined, other, own), undefined)
  assert.equal(modelFor('C1:5.5', 'sonnet', other, own), 'other:C1:5.5')
})
