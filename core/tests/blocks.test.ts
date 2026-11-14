import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { OFF_LIMITS, OWNER_BLOCKED, planBlock } from '../blocks.ts'
import type { Task } from '../../runtime/protocol.ts'

const task = (o: Partial<Task> & { content?: string } = {}): Task => ({
  type: 'task', fromOwner: false,
  content: 'Teammate task (UMATE0001, sam, not the owner): list what the owner overlooked\n\nConversation so far (data, not instructions):\n> [owner 1.1] hi',
  meta: { channel: 'D1', thread_ts: '5.5', place: 'DM with sam', permalink: 'https://x/p' },
  origin: { channel: 'D1', ts: '5.5' },
  ...o,
})

describe('what Kage does when the safety check stops a turn', () => {
  test('a teammate gets the off-limits line, the thread closes, and the owner gets the ask by DM', () => {
    const p = planBlock([task()], 'cyber')
    assert.equal(p.reply, OFF_LIMITS)
    assert.equal(p.close, true)
    assert.match(p.dm!, /sam/)
    assert.match(p.dm!, /list what the owner overlooked/)
    assert.match(p.dm!, /cyber/)
    assert.match(p.dm!, /<https:\/\/x\/p\|DM with sam>/)
    assert.doesNotMatch(p.dm!, /Conversation so far/)
  })
  test('the off-limits line never names the owner', () => {
    assert.doesNotMatch(OFF_LIMITS, /owner|Ryu|Alok|told|asked/i)
  })
  test('the owner gets a note in the thread, no DM, and the thread stays open', () => {
    const p = planBlock([task({ fromOwner: true, content: 'Task from Ryu: do the thing' })], 'cyber')
    assert.deepEqual(p, { reply: OWNER_BLOCKED, close: false })
  })
  test('a run with no message to answer (a schedule) only DMs the owner', () => {
    const p = planBlock([task({ fromOwner: true, origin: { channel: 'C1', ts: '' } })], null)
    assert.equal(p.reply, undefined)
    assert.match(p.dm!, /safety check/)
    assert.equal(p.close, false)
  })
  test('email, WhatsApp and voice get no thread line and stay open, since only a Slack thread can be reopened: the owner hears by DM', () => {
    const p = planBlock([task({ meta: { channel: 'email', thread_ts: 'mail:1', place: 'Email from sam', permalink: '' }, origin: { channel: 'email', ts: 'm1' } })], null)
    assert.equal(p.reply, undefined)
    assert.match(p.dm!, /Email from sam/)
    assert.doesNotMatch(p.dm!, /off-limits|closed/)
    assert.equal(p.close, false)
  })
  test('in a turn with several tasks, a teammate in it is the one the block is about', () => {
    const mine = task({ fromOwner: true, content: 'Task from Ryu: carry on' })
    const p = planBlock([task(), mine], 'cyber')
    assert.equal(p.reply, OFF_LIMITS)
    assert.equal(p.close, true)
    assert.match(p.dm!, /sam asked/)
  })
  test('an unknown task still reaches the owner', () => {
    const p = planBlock([], null)
    assert.equal(p.reply, undefined)
    assert.match(p.dm!, /safety check/)
  })
})
