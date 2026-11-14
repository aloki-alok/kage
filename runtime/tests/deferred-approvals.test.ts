import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deferredApprovals } from '../deferred-approvals.ts'
import type { Task } from '../protocol.ts'
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
})
