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
      hub: { posted: () => '', handled: () => {}, heard: () => {}, deliver: () => { heardBy++; return 'sent' }, channelPost: () => { throw new Error('boom') } } as never,
    })
    await slack.replay('s1', JSON.stringify({ type: 'message', channel: 'CTEST2', ts: '7.7', user: 'UTEST2', client_msg_id: 'm1', text: `<@${slack.ids.bot}> hello` }))
    assert.equal(heardBy, 1)   // a teammate's tag still started its task after the hook threw
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
