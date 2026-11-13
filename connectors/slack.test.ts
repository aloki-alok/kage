import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { intake, ownerNote } from './slack.ts'
import type { SlackMessage } from '../core/slack-message.ts'

const msg = { type: 'message', channel: 'CTEST1', ts: '5.5', user: 'UTEST1', text: 'hi' } as SlackMessage

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

describe('the owner\'s untagged reply in a thread is a note for its specialists; nobody else\'s is', () => {
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
