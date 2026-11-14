import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { answerDeferred, deferredApprovals } from '../deferred-approvals.ts'
import type { Task } from '../../core/task.ts'
import { openStore } from '../store.ts'

const HOUR = 3_600_000
const task: Task = { type: 'task', content: 'Task from TEST: deploy', fromOwner: true, meta: { channel: 'CTEST1', thread_ts: '5.5', place: '#test', permalink: '' }, origin: { channel: 'CTEST1', ts: '5.5' } }
const call = { id: 'abcde', key: 'CTEST1:5.5', tool: 'Bash', input: { command: 'ls' }, task }

describe('approvals that wait outside a session', () => {
  test('two yes replies release the call once', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    assert.equal(a.answer('abcde', 'allow', 1)?.key, 'CTEST1:5.5')
    assert.equal(a.answer('abcde', 'allow', 2), undefined)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 3), true)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 4), false)
  })

  test('a yes covers only the same call, and only before it goes stale', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    a.answer('abcde', 'allow', 1)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'rm -rf x' }, 2), false)
    assert.equal(a.take('CTEST1:9.9', 'Bash', { command: 'ls' }, 2), false)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, HOUR + 2), false)
  })

  test('a call nobody answered is not approved, and a no ends it', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 1), false)
    assert.equal(a.answer('abcde', 'deny', 2)?.tool, 'Bash')
    assert.equal(a.answer('abcde', 'allow', 3), undefined)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 4), false)
  })

  test('a restart keeps the card answerable', () => {
    const store = openStore(':memory:')
    deferredApprovals(store).add(call, 0)
    const after = deferredApprovals(store)
    assert.equal(after.answer('abcde', 'allow', 5)?.task.content, 'Task from TEST: deploy')
  })

  test('an id nobody asked for answers nothing', () => {
    assert.equal(deferredApprovals(openStore(':memory:')).answer('zzzzz', 'allow', 0), undefined)
  })

  test('a card answered a week late arms nothing, and old rows are swept', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    assert.equal(a.answer('abcde', 'allow', 7 * 24 * HOUR), undefined)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 7 * 24 * HOUR + 1), false)
    a.add(call, 0)
    a.add({ ...call, id: 'fghij' }, 7 * 24 * HOUR)   // an add sweeps the old row
    assert.equal(a.answer('abcde', 'deny', 7 * 24 * HOUR + 1), undefined)
    assert.equal(a.answer('fghij', 'deny', 7 * 24 * HOUR + 1)?.tool, 'Bash')
  })

  test('an answer starts a turn in the thread that asked, with the owner words from the card', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    const sent: [string, string][] = []
    assert.equal(answerDeferred(a, (k, t) => { sent.push([k, t.content]) }, 'abcde', 'allow', 1), true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]![0], 'CTEST1:5.5')
    assert.match(sent[0]![1], /said yes.*Bash.*again/)
    assert.equal(answerDeferred(a, (k, t) => { sent.push([k, t.content]) }, 'abcde', 'allow', 2), false)
    assert.equal(sent.length, 1)
  })

  test('a no tells the thread to stop and spends nothing', () => {
    const a = deferredApprovals(openStore(':memory:'))
    a.add(call, 0)
    const sent: string[] = []
    assert.equal(answerDeferred(a, (_k, t) => { sent.push(t.content) }, 'abcde', 'deny', 1), true)
    assert.match(sent[0]!, /said no.*Do not run it/)
    assert.equal(a.take('CTEST1:5.5', 'Bash', { command: 'ls' }, 2), false)
  })
})
