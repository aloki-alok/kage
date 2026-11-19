import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { intake, ownerNote, connectSlack } from '../slack.ts'
import { jevTriage } from '../jev.ts'
import { openLedgers, runEvents } from '../../runtime/ledger.ts'
import { log } from '../../runtime/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlackMessage } from '../../core/slack-message.ts'
import { sessionKey, type Conversation } from '../../core/conversations.ts'
import { senderOf } from '../../core/gate.ts'
import type { Task } from '../../core/task.ts'

const msg = { type: 'message', channel: 'CTEST1', ts: '5.5', user: 'UTEST1', text: 'hi' } as SlackMessage

test('a Slack triage decision writes one log line and keeps its database event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-triage-'))
  const lines: string[] = []
  const reactions: string[] = []
  const original = console.error
  console.error = (...args) => { lines.push(args.join(' ')) }
  const ledger = openLedgers(dir, () => '2026-01-01T00:00:00Z', log)
  try {
    const runs = runEvents(ledger, () => 'test-trace')
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async (o: { name: string }) => { reactions.push(o.name); return { ok: true } } },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('a thanks needs no session') } as never,
      triage: jevTriage({ key: 'test', model: 'test', threshold: 0.5, agents: 'all', url: 'https://jev.example.com' },
        (who, detail) => runs.emit(who, 'triage', detail),
        { fetch: (async () => Response.json({ answers: { intake: { choice: 'react', probabilities: { react: 0.99 } }, reaction: { choice: 'folded_hands', confidence: 1 } } })) as typeof fetch }),
    })
    await slack.replay('test-source', JSON.stringify({ ...msg, client_msg_id: 'test', text: '@kage thanks' }))
    const events = ledger.events('2026-01-01')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'triage')
    assert.match(events[0]!.detail, /^react: owner react 0\.99, reaction folded_hands 1\.00, \d+ ms$/)
    assert.deepEqual(reactions, ['pray'])
    assert.equal(lines.filter(l => l.includes('triage ')).length, 1, lines.join('\n'))
  } finally {
    ledger.close()
    console.error = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a message triage sends to react, with no emoji picked, still gets the eyes, so it is never dropped without a sign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-triage-'))
  const reactions: string[] = []
  const ledger = openLedgers(dir, () => '2026-01-01T00:00:00Z', log)
  try {
    const runs = runEvents(ledger, () => 'test-trace')
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async (o: { name: string }) => { reactions.push(o.name); return { ok: true } } },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('an ok needs no session') } as never,
      triage: jevTriage({ key: 'test', model: 'test', threshold: 0.5, agents: 'all', url: 'https://jev.example.com' },
        (who, detail) => runs.emit(who, 'triage', detail),
        { fetch: (async () => Response.json({ answers: { intake: { choice: 'react', probabilities: { react: 0.99 } }, reaction: { choice: 'none', confidence: 0.9 } } })) as typeof fetch }),
    })
    await slack.replay('test-source', JSON.stringify({ ...msg, client_msg_id: 'test', text: '@kage ok' }))
    assert.deepEqual(reactions, ['eyes'])
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a listed agent\'s post that Jev says needs no reply gets one fresh line that tags no one, so the thread never looks ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-jev-'))
  const posts: { thread_ts?: string; text: string }[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
      chat: { postMessage: async (o: { thread_ts?: string; text: string }) => { posts.push(o); return { ok: true } } },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: ['UMATE0002'], apps: ['ATEST0001'],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('a post that needs no reply starts no session') } as never,
      jev: async () => ({ reply: false, why: 'jev needs_reply 0.10 (threshold 0.5)' }),
      heard: async () => 'Dropped',
    })
    await slack.replay('test-source', JSON.stringify({ ...msg, user: 'UMATE0002', app_id: 'ATEST0001', bot_id: 'BTEST0001', text: '<@UTEST1> done, no reply needed' }))
    assert.equal(posts.length, 1)
    assert.equal(posts[0]!.thread_ts, '5.5')
    assert.equal(posts[0]!.text, 'Dropped :ninja:')
    assert.ok(!posts[0]!.text.includes('<@'), 'no tag, so the agent is not woken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with jev.ackWords off, a skipped agent post gets a green tick and no reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-jev-'))
  const posts: unknown[] = [], reactions: string[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async (o: { name: string }) => { reactions.push(o.name); return { ok: true } } },
      chat: { postMessage: async (o: unknown) => { posts.push(o); return { ok: true } } },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: ['UMATE0002'], apps: ['ATEST0001'],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('a post that needs no reply starts no session') } as never,
      jev: async () => ({ reply: false, why: 'jev needs_reply 0.10 (threshold 0.5)' }),
      heard: async () => assert.fail('no words are written when ackWords is off'), ackWords: false,
    })
    await slack.replay('test-source', JSON.stringify({ ...msg, user: 'UMATE0002', app_id: 'ATEST0001', bot_id: 'BTEST0001', text: '<@UTEST1> done, no reply needed' }))
    assert.deepEqual({ posts, reactions }, { posts: [], reactions: ['white_check_mark'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a held message that starts on its replay loses the hourglass, so only the ninja shows it is being worked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-held-'))
  const removed: string[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'general' } }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      chat: { getPermalink: async () => ({ permalink: '' }) },
      reactions: { add: async () => ({ ok: true }), remove: async (o: { name: string; timestamp: string }) => { removed.push(`${o.timestamp} ${o.name}`); return { ok: true } } },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: () => 'sent' } as never,
    })
    await slack.replay('test-a', JSON.stringify({ ...msg, client_msg_id: 'a', ts: '6.6', text: '<@UTEST1> check the logs' }))
    assert.deepEqual(removed, ['6.6 hourglass_flowing_sand'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ask from a person on a kagelet\'s people line goes to that kagelet and starts no Kage session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-ask-'))
  const asks: unknown[][] = [], posts: string[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'general' } }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      chat: { getPermalink: async () => ({ permalink: '' }), postMessage: async (a: { text: string }) => { posts.push(a.text); return { ok: true } } },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('a people-line ask never starts a Kage session'),
        kageletsIn: (chat: string, thread: string) => chat === 'CTEST1' && thread === '6.0' ? [{ name: 'fude', people: ['UPEOPLE1'] }] : [],
        kageletAsk: (...a: unknown[]) => { asks.push(a); return 'Asked fude. It answers here.' } } as never,
    })
    await slack.replay('test-ask', JSON.stringify({ ...msg, user: 'UPEOPLE1', client_msg_id: 'a', ts: '6.6', thread_ts: '6.0', text: '<@UTEST1> draft one on pricing' }))
    assert.deepEqual(asks, [['CTEST1', '6.0', 'fude', 'UPEOPLE1', 'draft one on pricing']])
    assert.deepEqual(posts, ['Asked fude. It answers here.'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('the thread a session reads names the owner\'s Slack id, so a tag for the owner never needs a guessed id (#319)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-legend-'))
  const tasks: string[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'general' } }),
        replies: async () => ({ messages: [{ user: 'UTEST2', ts: '6.0', text: 'confirm it with your owner first' }] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      chat: { getPermalink: async () => ({ permalink: '' }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: (_c: unknown, task: { content: string }) => { tasks.push(task.content); return 'sent' } } as never,
    })
    await slack.replay('test-legend', JSON.stringify({ ...msg, client_msg_id: 'a', ts: '6.6', thread_ts: '6.0', text: '<@UTEST1> check the logs' }))
    assert.equal(tasks.length, 1)
    assert.match(tasks[0]!, /People \(display names, unverified\): owner:UTEST1 = Sam Test; other:UTEST2 = Sam Test\n/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a task is the owner\'s only when the owner\'s own user posted it (#273)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-owner-'))
  const tasks: { fromOwner: boolean }[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'general' } }),
        replies: async () => ({ messages: [{ user: 'UTEST1', ts: '6.0', text: 'the owner started this thread' }] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      chat: { getPermalink: async () => ({ permalink: '' }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: ['UTEST2'], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: (_c: unknown, task: { fromOwner: boolean }) => { tasks.push(task); return 'sent' } } as never,
    })
    await slack.replay('test-owner', JSON.stringify({ ...msg, client_msg_id: 'a', ts: '6.6', thread_ts: '6.0', text: '<@UTEST1> check the logs' }))
    await slack.replay('test-teammate', JSON.stringify({ ...msg, user: 'UTEST2', client_msg_id: 'b', ts: '6.7', thread_ts: '6.0', text: '<@UTEST1> check the logs' }))
    assert.deepEqual(tasks.map(t => t.fromOwner), [true, false])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('a Slack event reaches the inbox before Slack is told it arrived', () => {
  test('the write comes before the ack, then the message is handled with its source id', async () => {
    const steps: string[] = []
    await intake(msg, async () => { steps.push('ack') }, { take: s => (steps.push(`take ${s}`), true) }, async (_, s) => { steps.push(`hear ${s}`) })
    assert.deepEqual(steps, ['take slack:CTEST1:5.5', 'ack', 'hear slack:CTEST1:5.5'])
  })
  test('a failed write is never acked, so Slack sends the event again', async () => {
    let acked = false
    await assert.rejects(intake(msg, async () => { acked = true }, { take: () => { throw new Error('disk full') } }, async () => {}))
    assert.equal(acked, false)
  })
  test('a redelivery is acked and not handled again', async () => {
    let acked = false, heard = false
    await intake(msg, async () => { acked = true }, { take: () => false }, async () => { heard = true })
    assert.deepEqual({ acked, heard }, { acked: true, heard: false })
  })
  test('a Slack event never carries fromSocket, which only kage say sets', async () => {
    let payload = '', heard: SlackMessage | undefined
    await intake({ ...msg, fromSocket: true }, async () => {}, { take: (_, __, p) => ((payload = p ?? ''), true) }, async m => { heard = m })
    assert.equal(heard?.fromSocket, undefined)
    assert.equal(JSON.parse(payload).fromSocket, undefined)
  })
  test('an event with no channel or ts is handled without a record, so two of them never collide', async () => {
    let heard = 0
    const bare = { type: 'message', subtype: 'message_changed' } as unknown as SlackMessage
    for (let i = 0; i < 2; i++) await intake(bare, async () => {}, { take: () => assert.fail('nothing to record') }, async () => { heard++ })
    assert.equal(heard, 2)
  })
})

describe('the owner\'s untagged reply in a thread is a note for its kagelets; nobody else\'s is', () => {
  const ids = { owner: 'UOWNER', botDm: 'DBOT' }
  const m = (o: Record<string, unknown>) => ({ type: 'message', channel: 'C1', ts: '2.2', thread_ts: '1.1', user: 'UOWNER', text: 'skip staging', client_msg_id: 'x', ...o }) as never
  test('the owner, typed, in a thread', () => {
    assert.equal(ownerNote(m({}), ids, 'not-tagged'), true)
  })
  test('not a teammate, not a tagged task, not the DM, not a top-level message, not a bot post', () => {
    assert.equal(ownerNote(m({ user: 'UMATE' }), ids, 'not-tagged'), false)
    assert.equal(ownerNote(m({}), ids, 'not-listed'), false)
    assert.equal(ownerNote(m({ channel: 'DBOT' }), ids, 'not-tagged'), false)
    assert.equal(ownerNote(m({ thread_ts: undefined }), ids, 'not-tagged'), false)
    assert.equal(ownerNote(m({ thread_ts: '2.2' }), ids, 'not-tagged'), false)
    assert.equal(ownerNote(m({ client_msg_id: undefined, bot_id: 'B1' }), ids, 'not-tagged'), false)
  })
})

test('a bot post in a channel reaches channelPost, quoted, and is still dropped as untagged; a DM post does not reach it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-channel-post-'))
  const heard: { channel: string; bot?: boolean; app_id?: string; quoted: string }[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, heard: () => {}, deliver: () => assert.fail('an untagged post starts no task'), channelPost: (p: (typeof heard)[number]) => void heard.push(p) } as never,
    })
    await slack.replay('s1', JSON.stringify({ type: 'message', subtype: 'bot_message', bot_id: 'BTEST1', app_id: 'ATEST9', channel: 'CTEST2', ts: '7.7', text: 'disk full on web-1' }))
    await slack.replay('s2', JSON.stringify({ type: 'message', channel: 'DTEST9', channel_type: 'im', ts: '8.8', user: 'UTEST2', client_msg_id: 'x', text: 'hello' }))
    assert.equal(heard.length, 1)
    assert.equal(heard[0]!.channel, 'CTEST2')
    assert.equal(heard[0]!.bot, true)
    assert.match(heard[0]!.quoted, /^> \[other:bot 7\.7\] disk full on web-1$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("in the owner's DM, a reply under their own message goes to the same session as that message, and a reply under a Kage post keeps its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-dm-thread-'))
  const keys: string[] = []
  try {
    const client = (user_id: string) => ({
      auth: { test: async () => ({ team_id: 'TTEST', user_id }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'test' } }), replies: async () => ({ messages: [] }) },
      chat: { getPermalink: async () => ({ permalink: 'https://test.invalid/p' }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    })
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client('UBOT1') as never, user: client('UOWNER1') as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '1\tDTEST\t2.2\tbot\tdm', handled: () => {}, heard: () => {}, deliver: (c: Conversation) => { keys.push(sessionKey(c)); return 'sent' } } as never,
    })
    const dm = (ts: string, thread_ts?: string) => JSON.stringify({ type: 'message', channel: 'DTEST', channel_type: 'im', ts, ...(thread_ts && { thread_ts }), user: 'UOWNER1', client_msg_id: `m${ts}`, text: 'how is it going?' })
    await slack.replay('s1', dm('1.1'))
    await slack.replay('s2', dm('1.5', '1.1'))
    await slack.replay('s3', dm('2.5', '2.2'))
    assert.deepEqual(keys, ['dm', 'dm', 'DTEST:2.2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a post that tags Kage starts its task and never reaches channelPost too, so a watch on the channel does not answer it twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-channel-tag-'))
  const heard: { ts: string }[] = []
  let tasks = 0
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'test' } }), replies: async () => ({ messages: [] }) },
      chat: { getPermalink: async () => ({ permalink: 'https://test.invalid/p' }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: ['UTEST2'], apps: [],
      hub: { posted: () => '', handled: () => {}, heard: () => {}, deliver: () => { tasks++; return 'sent' }, channelPost: (p: (typeof heard)[number]) => void heard.push(p) } as never,
    })
    await slack.replay('s1', JSON.stringify({ type: 'message', channel: 'CTEST2', ts: '7.8', thread_ts: '7.7', user: 'UTEST2', client_msg_id: 'm1', text: `are you using a kagelet? <@${slack.ids.bot}>` }))
    await slack.replay('s2', JSON.stringify({ type: 'message', channel: 'CTEST2', ts: '7.9', thread_ts: '7.7', user: 'UTEST2', client_msg_id: 'm2', text: 'thanks, looks fine' }))
    assert.equal(tasks, 1)
    assert.deepEqual(heard.map(p => p.ts), ['7.9'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an alarm post with empty text still reaches channelPost with its attachment and block text, quoted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-channel-post-'))
  const heard: { text: string; quoted: string }[] = []
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, heard: () => {}, deliver: () => {}, channelPost: (p: (typeof heard)[number]) => void heard.push(p) } as never,
    })
    await slack.replay('s1', JSON.stringify({ type: 'message', subtype: 'bot_message', bot_id: 'BTEST1', app_id: 'ATEST9', channel: 'CTEST2', ts: '7.7', text: '',
      attachments: [{ title: 'ALARM: web-1 disk', text: 'Threshold crossed', fields: [{ title: 'Region', value: 'eu-test-1' }] }],
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'block says paged' } }, { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'rich says urgent' }] }] }] }))
    assert.equal(heard.length, 1)
    for (const word of ['ALARM: web-1 disk', 'Threshold crossed', 'Region', 'eu-test-1', 'block says paged', 'rich says urgent']) {
      assert.ok(heard[0]!.text.includes(word), `text lacks ${word}`)
      assert.ok(heard[0]!.quoted.includes(word), `quoted lacks ${word}`)
    }
    assert.ok(heard[0]!.quoted.split('\n').every(l => l.startsWith('> ')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a throw in channelPost never stops the next hook or the handling of the message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-channel-throw-'))
  let heardBy = 0
  try {
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'test' } }), replies: async () => ({ messages: [] }) },
      chat: { getPermalink: async () => ({ permalink: 'https://test.invalid/p' }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: ['UTEST2'], apps: [],
      hub: { posted: () => '', handled: () => {}, heard: () => { heardBy++ }, deliver: () => 'sent', channelPost: () => { throw new Error('boom') } } as never,
    })
    await slack.replay('s1', JSON.stringify({ type: 'message', channel: 'CTEST2', ts: '7.8', thread_ts: '7.7', user: 'UTEST2', client_msg_id: 'm1', text: 'hello' }))
    assert.equal(heardBy, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("an app on the owner's Mac posts the owner's words and they run as the owner's task", () => {
  const setup = async (dir: string) => {
    const posts: Record<string, unknown>[] = []
    const tasks: { key: string; kind: string; fromOwner: boolean; content: string }[] = []
    const inbox = new Set<string>()
    const take = (s: string) => !inbox.has(s) && !!inbox.add(s)
    let told = () => {}
    const delivered = () => Promise.race([new Promise<void>(r => { told = r }), new Promise<void>((_, no) => setTimeout(() => no(new Error('no task delivered')), 1000).unref())])
    const client = (user_id: string) => ({
      auth: { test: async () => ({ team_id: 'TTEST', user_id }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'test' } }), replies: async () => ({ messages: [] }) },
      chat: { getPermalink: async () => ({ permalink: 'https://test.invalid/p' }), postMessage: async (a: Record<string, unknown>) => { posts.push({ as: user_id, ...a }); take(`slack:${String(a.channel)}:9.${posts.length}`); return { ok: true, ts: `9.${posts.length}` } } },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    })
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client('UBOT1') as never, user: client('UOWNER1') as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', take, handled: () => {}, heard: () => {},
        deliver: (c: Conversation, t: { fromOwner: boolean; content: string }) => { tasks.push({ key: sessionKey(c), kind: c.kind, fromOwner: t.fromOwner, content: t.content }); told(); return 'sent' } } as never,
    })
    return { slack, posts, tasks, delivered }
  }

  test('a new message lands in the DM with Kage as the owner, and starts the DM task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-say-'))
    try {
      const { slack, posts, tasks, delivered } = await setup(dir)
      const done = delivered()
      assert.deepEqual(await slack.say('how many signups today?'), { channel: 'DTEST', ts: '9.1' })
      await done
      assert.deepEqual(posts, [{ as: 'UOWNER1', channel: 'DTEST', text: 'how many signups today?' }])
      assert.equal(tasks.length, 1)
      assert.equal(tasks[0]!.key, 'dm')
      assert.equal(tasks[0]!.fromOwner, true)
      assert.match(tasks[0]!.content, /^Task from Sam: how many signups today\?/)
      await slack.replay('echo', JSON.stringify({ type: 'message', channel: 'DTEST', channel_type: 'im', ts: '9.1', user: 'UOWNER1', app_id: 'ATEST1', text: 'how many signups today?' }))
      assert.equal(tasks.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a reply lands in its thread untagged, and reaches that thread\'s session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-say-'))
    try {
      const { slack, posts, tasks, delivered } = await setup(dir)
      const done = delivered()
      await slack.say('and yesterday?', { channel: 'CTEST2', thread_ts: '7.7', kind: 'channel' })
      await done
      assert.deepEqual(posts, [{ as: 'UOWNER1', channel: 'CTEST2', thread_ts: '7.7', text: 'and yesterday?' }])
      assert.deepEqual(tasks.map(t => [t.key, t.kind, t.fromOwner]), [['CTEST2:7.7', 'channel', true]])
      assert.match(tasks[0]!.content, /^Task from Sam: and yesterday\?/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a listed agent's post runs with its person's trust, never the owner's (#426)", () => {
  async function agentTask(apps: string[], user: string, app?: string, trusted: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'kage-agent-'))
    const tasks: Task[] = []
    try {
      const client = {
        auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
        conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async () => ({ messages: [] }), info: async () => ({ channel: { name: 'general' } }), replies: async () => ({ messages: [] }) },
        users: { info: async (o: { user: string }) => ({ user: { real_name: o.user === 'UTEST1' ? 'Ryu Test' : 'Kevin Test' } }) },
        chat: { getPermalink: async () => ({ permalink: '' }) },
        reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      }
      const slack = await connectSlack({
        dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
        name: 'kage', title: 'Kage', teammates: ['UMATE0002'], trusted, apps,
        hub: { posted: () => '', handled: () => {}, deliver: (_c: unknown, task: Task) => { tasks.push(task); return 'sent' } } as never,
        jev: async () => ({ reply: true, why: 'jev needs_reply 0.90' }),
      })
      await slack.replay('test-agent', JSON.stringify({ ...msg, user, ...app ? { app_id: app, bot_id: 'BTEST0001' } : { client_msg_id: 'typed' }, text: '<@UTEST1> deploy the api to prod' }))
      assert.equal(tasks.length, 1)
      return tasks[0]!
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("a teammate's agent gets that teammate's trust", async () => {
    const t = await agentTask(['A0AGENT02:UMATE0002'], 'UMATE0002', 'A0AGENT02')
    assert.equal(senderOf(t), 'teammate')
    assert.match(t.content, /^Teammate task \(UMATE0002, Kevin Test's agent, not the owner\): /)
  })

  test('with one app listed under two people, the post runs as the agent of the person whose token posted it', async () => {
    const t = await agentTask(['A0AGENT02:UMATE0009', 'A0AGENT02:UMATE0002'], 'UMATE0002', 'A0AGENT02')
    assert.equal(t.agent?.person, 'UMATE0002')
  })

  test('an agent owned by another agent is not given a person', async () => {
    const t = await agentTask(['A0AGENT04:A0AGENT05', 'A0AGENT05:UMATE0002', 'A0AGENT04'], 'UMATE0002', 'A0AGENT04')
    assert.equal(t.agent?.person, undefined)
    assert.equal(senderOf(t), 'agent')
  })

  test("a trusted teammate's own task, and their agent's, run at the trusted level and say so (#425)", async () => {
    const own = await agentTask([], 'UMATE0002', undefined, ['UMATE0002'])
    assert.equal(senderOf(own), 'trusted')
    assert.match(own.content, /trusts <@UMATE0002> with their connected accounts/)
    const agent = await agentTask(['A0AGENT02:UMATE0002'], 'UMATE0002', 'A0AGENT02', ['UMATE0002'])
    assert.equal(senderOf(agent), 'trusted')
    const plain = await agentTask([], 'UMATE0002')
    assert.equal(senderOf(plain), 'teammate')
    assert.doesNotMatch(plain.content, /trusts/)
  })

  test('an agent tied to no person stays read and answer only', async () => {
    const t = await agentTask(['A0AGENT03'], 'UMATE0002', 'A0AGENT03')
    assert.equal(senderOf(t), 'agent')
  })
})
