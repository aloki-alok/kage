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
  const original = console.error
  console.error = (...args) => { lines.push(args.join(' ')) }
  const ledger = openLedgers(dir, () => '2026-01-01T00:00:00Z', log)
  try {
    const runs = runEvents(ledger, () => 'test-trace')
    const client = {
      auth: { test: async () => ({ team_id: 'TTEST', user_id: 'UTEST1' }) },
      conversations: { open: async () => ({ channel: { id: 'DTEST' } }) },
      users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
      reactions: { add: async () => ({ ok: true }) },
    }
    const slack = await connectSlack({
      dir, appToken: 'test', userToken: 'test', bot: client as never, user: client as never,
      name: 'kage', title: 'Kage', teammates: [], apps: [],
      hub: { posted: () => '', handled: () => {}, deliver: () => assert.fail('a thanks needs no session') } as never,
      triage: jevTriage({ key: 'test', model: 'test', threshold: 0.5, agents: 'all', url: 'https://jev.example.com' },
        (who, detail) => runs.emit(who, 'triage', detail),
        { fetch: (async () => Response.json({ answers: { intake: { choice: 'react', probabilities: { react: 0.99 } } } })) as typeof fetch }),
    })
    await slack.replay('test-source', JSON.stringify({ ...msg, client_msg_id: 'test', text: '@kage thanks' }))
    const events = ledger.events('2026-01-01')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'triage')
    assert.equal(events[0]!.detail, 'react: owner react 0.99')
    assert.equal(lines.filter(l => l.includes('triage ')).length, 1, lines.join('\n'))
  } finally {
    ledger.close()
    console.error = original
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
