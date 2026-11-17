import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addressed, agentNote, agentRoster, loopGuard } from '../agents.ts'

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
  test('a tag inside code does not count, because Slack sends no mention from code', () => {
    assert.deepEqual(addressed(['```\n<@UAGENT001> row\n```'], 'UAGENT001'), ['<@UAGENT001>\n```\n<@UAGENT001> row\n```'])
    assert.deepEqual(addressed(['run `<@UAGENT001>` here'], 'UAGENT001'), ['<@UAGENT001> run `<@UAGENT001>` here'])
    assert.deepEqual(addressed(['```\nx\n``` then <@UAGENT001>'], 'UAGENT001'), ['```\nx\n``` then <@UAGENT001>'])
  })
  test('a tag for someone else does not count', () => {
    assert.deepEqual(addressed(['<@UAGENT002> hi'], 'UAGENT001'), ['<@UAGENT001> <@UAGENT002> hi'])
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
    // A dropped turn is not counted. The first turn leaves the window at exactly 60 s, so one more fits then, not a ms before.
    assert.ok(g.turn('ATEST0001', 'C1:95', 59_999))
    assert.equal(g.turn('ATEST0001', 'C1:97', 60_000), undefined)
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
    assert.match(note, /tag_agent=true/)
    assert.match(note, /stay untagged/)
  })
  test('with no saved tag it says the agent may not hear the reply', () => {
    assert.match(agentNote('ATEST0001'), /no tag saved/)
    assert.ok(!agentNote('ATEST0001').includes('tag_agent=true'))
  })
})

describe('the agents a session can address', () => {
  test('lists each listed agent that has a saved tag, with its owner, and says an agent hears only a post that tags it', () => {
    const line = agentRoster(['A0AGENT1:U0OWNER1:U0BOT001', 'A0AGENT2:U0OWNER2'])!
    assert.match(line, /<@U0BOT001> \(<@U0OWNER1>'s agent\)/)
    assert.doesNotMatch(line, /A0AGENT2/)   // no tag saved: it cannot be addressed, so it is not offered
    assert.match(line, /hears only a post that tags it/)
    assert.equal(agentRoster(['A0AGENT2:U0OWNER2']), undefined)
    assert.match(agentRoster(['A0AGENT3:A0OTHER1:U0BOT003'])!, /<@U0BOT003>[,.]/)   // an app owner is no person to name
    assert.equal(agentRoster([]), undefined)
  })
})
