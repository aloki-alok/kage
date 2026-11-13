import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addressed, agentNote, loopGuard, needsNoReply, NO_REPLY } from './agents.ts'

describe('a post addressed to an agent', () => {
  test('every part of a split post carries the tag, not only the first', () => {
    assert.deepEqual(addressed(['part one', 'part two', 'part three'], 'UAGENT001'), ['<@UAGENT001> part one', '<@UAGENT001> part two', '<@UAGENT001> part three'])
  })
  test('a part that already tags the agent is left as it is', () => {
    assert.deepEqual(addressed(['Hi <@UAGENT001>, here it is', 'the rest'], 'UAGENT001'), ['Hi <@UAGENT001>, here it is', '<@UAGENT001> the rest'])
  })
  test('a part that opens a code block gets the tag on its own line, so the block still renders', () => {
    assert.deepEqual(addressed(['```\nrow 1\n```', 'text'], 'UAGENT001'), ['<@UAGENT001>\n```\nrow 1\n```', '<@UAGENT001> text'])
  })
  test('a tag for someone else does not count', () => {
    assert.deepEqual(addressed(['<@UAGENT002> hi'], 'UAGENT001'), ['<@UAGENT001> <@UAGENT002> hi'])
  })
})

describe('a post that needs no answer', () => {
  test('says so with one marker, in any case and inside Slack italics', () => {
    assert.equal(needsNoReply(`Thanks, got it. ${NO_REPLY}`), true)
    assert.equal(needsNoReply('Done. _(No reply needed)_'), true)
    assert.equal(needsNoReply('(no  reply\nneeded)'), true)
  })
  test('other words do not count', () => {
    for (const t of ['', 'no reply needed', 'reply needed', '(no reply)', 'I need no reply (really)']) assert.equal(needsNoReply(t), false, t)
  })
})

describe('the loop guard between Kage and one agent', () => {
  const guard = () => loopGuard({ perWindow: 20, windowMs: 60_000, hops: 4 })
  test('at most 4 turns from the agent in a row in one thread; the 5th is a loop until a person writes there', () => {
    const g = guard()
    for (let i = 0; i < 4; i++) assert.equal(g.turn('ATEST0001', 'C1:5.5', i * 30_000), undefined)
    assert.match(g.turn('ATEST0001', 'C1:5.5', 150_000) ?? '', /5 turns in a row/)
    assert.match(g.turn('ATEST0001', 'C1:5.5', 9_000_000) ?? '', /turns in a row/)   // time alone does not clear it
    g.person('C1:5.5')
    assert.equal(g.turn('ATEST0001', 'C1:5.5', 9_000_001), undefined)
  })
  test('hops are per thread and per agent', () => {
    const g = guard()
    for (let i = 0; i < 4; i++) g.turn('ATEST0001', 'C1:5.5', i * 30_000)
    assert.equal(g.turn('ATEST0001', 'C1:7.7', 130_000), undefined)
    assert.equal(g.turn('ATEST0002', 'C1:5.5', 130_000), undefined)
    g.person('C1:7.7')   // a person in another thread clears nothing here
    assert.ok(g.turn('ATEST0001', 'C1:5.5', 140_000))
  })
  test('at most 20 turns from one agent in 60 s, across threads; the window slides', () => {
    const g = guard()
    for (let i = 0; i < 20; i++) assert.equal(g.turn('ATEST0001', `C1:${i}`, i * 1000), undefined)
    assert.match(g.turn('ATEST0001', 'C1:99', 20_000) ?? '', /20 turns in 60 s/)
    assert.equal(g.turn('ATEST0002', 'C1:98', 20_000), undefined)   // another agent has its own count
    // A dropped turn is not counted. The first turn leaves the window at 60 s, so one more fits.
    assert.equal(g.turn('ATEST0001', 'C1:97', 60_001), undefined)
    assert.ok(g.turn('ATEST0001', 'C1:96', 60_002))
  })
  test('the owner is told once per agent and hour, not once per dropped message', () => {
    const g = guard()
    for (let i = 0; i < 4; i++) g.turn('ATEST0001', 'C1:5.5', i)
    g.turn('ATEST0001', 'C1:5.5', 10)
    assert.equal(g.tell('ATEST0001', 10), true)
    assert.equal(g.tell('ATEST0001', 20), false)
    assert.equal(g.tell('ATEST0002', 20), true)
    assert.equal(g.tell('ATEST0001', 10 + 3_600_000), true)
  })
})

describe('what a session is told about an agent\'s task', () => {
  test('one line: who posted, that it approves nothing, and how the reply reaches it', () => {
    const note = agentNote('ATEST0001', 'UAGENT001')
    assert.ok(!note.includes('\n'))
    assert.match(note, /Slack app ATEST0001/)
    assert.match(note, /can approve nothing/)
    assert.match(note, /tags the agent by itself/)
    assert.match(note, /no_reply_needed=true/)
  })
  test('with no saved tag it says the agent may not hear the reply', () => {
    assert.match(agentNote('ATEST0001'), /no tag saved/)
    assert.ok(!agentNote('ATEST0001').includes('tags the agent by itself'))
  })
})
