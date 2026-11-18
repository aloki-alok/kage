import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { counted, dayOf, decide, sendsTo } from '../decide.ts'
import type { MetaEvent } from '../meta.ts'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const msg: MetaEvent = { kind: 'message', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'm1', text: 'hi', at: NOW }
const L = { repliesPerLeadPerDay: 3, humanQuietHours: 72 }

describe('whether a lead gets a reply', () => {
  test('a new lead gets one', () => assert.deepEqual(decide(msg, undefined, NOW, 'APP', L), { act: 'reply' }))

  test("our own echo is ignored; anyone else's echo is a person answering", () => {
    const echo = (appId?: string): MetaEvent => ({ kind: 'echo', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'e1', at: NOW, ...(appId ? { appId } : {}) })
    assert.deepEqual(decide(echo('APP'), undefined, NOW, 'APP', L), { act: 'skip', why: 'our_echo' })
    assert.deepEqual(decide(echo('INBOX'), undefined, NOW, 'APP', L), { act: 'human' })
    assert.deepEqual(decide(echo(), undefined, NOW, 'APP', L), { act: 'human' })
  })

  test('after a person answers, the bot stays quiet for the set hours, then may answer again', () => {
    const t = { day: dayOf(NOW), repliesToday: 0, humanAt: NOW - 71 * 3_600_000 }
    assert.deepEqual(decide(msg, t, NOW, 'APP', L), { act: 'skip', why: 'human_took_over' })
    assert.deepEqual(decide(msg, { ...t, humanAt: NOW - 73 * 3_600_000 }, NOW, 'APP', L), { act: 'reply' })
  })

  test('the daily cap holds within a day and resets the next', () => {
    let t = counted(counted(counted(undefined, NOW), NOW), NOW)
    assert.equal(t.repliesToday, 3)
    assert.deepEqual(decide(msg, t, NOW, 'APP', L), { act: 'skip', why: 'over_limit' })
    const tomorrow = NOW + 24 * 3_600_000
    assert.deepEqual(decide(msg, t, tomorrow, 'APP', L), { act: 'reply' })
    t = counted(t, tomorrow)
    assert.equal(t.repliesToday, 1)
  })
})

describe('who a reply goes to', () => {
  test('dry never sends, team sends only to testers, live sends to all', () => {
    assert.equal(sendsTo('dry', 'U1', ['U1']), false)
    assert.equal(sendsTo('team', 'U1', ['U1']), true)
    assert.equal(sendsTo('team', 'U2', ['U1']), false)
    assert.equal(sendsTo('live', 'U2', []), true)
    assert.equal(sendsTo('off', 'U1', ['U1']), false)
  })
})
