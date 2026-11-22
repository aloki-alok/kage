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
    a.add({ ...call, id: 'fghij' }, 7 * 24 * HOUR)
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

  test('an always answer also hands the call to keep as a rule; a plain yes or a no does not', () => {
    const kept: string[] = []
    for (const [id, behavior, always] of [['a1', 'allow', true], ['a2', 'allow', false], ['a3', 'deny', true]] as const) {
      const a = deferredApprovals(openStore(':memory:'))
      a.add({ ...call, id }, 0)
      answerDeferred(a, () => {}, id, behavior, 1, always ? c => { kept.push(`${id} ${c.tool}`) } : undefined)
    }
    assert.deepEqual(kept, ['a1 Bash'])
  })
  test('each answer writes one verdict: the step kind, a fingerprint for the command, the owner and the reviewer, never the command', () => {
    const seen: object[] = []
    const a = deferredApprovals(openStore(':memory:'), v => { seen.push(v) })
    const push = { ...call, input: { command: 'git push --force origin feat/a' } }
    a.add({ ...push, id: 'v1', review: 'run' }, 0)
    a.add({ ...push, id: 'v2' }, 0)
    a.add({ ...call, id: 'v3', tool: 'mcp__gmail__send', input: { to: 'x' } }, 0)
    answerDeferred(a, () => {}, 'v1', 'allow', 1, () => {})
    answerDeferred(a, () => {}, 'v2', 'deny', 2)
    answerDeferred(a, () => {}, 'v3', 'allow', 3)
    answerDeferred(a, () => {}, 'v3', 'allow', 4)
    const fp = (seen[0] as { fp: string }).fp
    assert.match(fp, /^[0-9a-f]{12}$/)
    assert.deepEqual(seen, [
      { key: 'CTEST1:5.5', tool: 'Bash', kind: 'a forced push or a branch delete', fp, owner: 'always', review: 'run' },
      { key: 'CTEST1:5.5', tool: 'Bash', kind: 'a forced push or a branch delete', fp, owner: 'deny' },
      { key: 'CTEST1:5.5', tool: 'mcp__gmail__send', kind: 'mcp__gmail__send', fp: (seen[2] as { fp: string }).fp, owner: 'allow' },
    ])
    assert.notEqual((seen[2] as { fp: string }).fp, fp)
    assert.doesNotMatch(JSON.stringify(seen), /feat\/a/)
  })

  test('a card nobody answered before it went stale writes one expired verdict; a spent yes going stale writes none', () => {
    const seen: { owner: string }[] = []
    const a = deferredApprovals(openStore(':memory:'), v => { seen.push(v) })
    a.add({ ...call, id: 'e1' }, 0)
    a.add({ ...call, id: 'e2', input: { command: 'pwd' } }, 0)
    a.answer('e2', 'allow', 1)
    a.take('CTEST1:9.9', 'Bash', { command: 'ls' }, 25 * HOUR)
    a.take('CTEST1:9.9', 'Bash', { command: 'ls' }, 26 * HOUR)
    assert.deepEqual(seen.map(v => v.owner), ['allow', 'expired'])
  })

  test('a stale card seen by a wait check and then by a new card is reported expired once', () => {
    const seen: { owner: string }[] = []
    const a = deferredApprovals(openStore(':memory:'), v => { seen.push(v) })
    a.add({ ...call, id: 'w1' }, 0)
    a.waiting('CTEST1:9.9', 'Bash', { command: 'ls' }, 25 * HOUR)
    a.add({ ...call, id: 'w2', input: { command: 'pwd' } }, 26 * HOUR)
    assert.deepEqual(seen.map(v => v.owner), ['expired'])
  })

  test('a no holds that exact step on that thread for the hold days; a yes, another step or another thread is not held', () => {
    const DAY = 24 * HOUR
    const a = deferredApprovals(openStore(':memory:'), undefined, () => 7)
    const lane = 'C0TEST1:5.5#side-kagelet-ops'
    a.add({ ...call, key: lane, id: 'h1', input: { command: 'git push --force origin feat/a' } }, 0)
    a.add({ ...call, key: lane, id: 'h2', input: { command: 'rm -rf build' } }, 0)
    a.answer('h1', 'deny', 10)
    a.answer('h2', 'allow', 10)
    assert.equal(a.deniedAt(lane, 'Bash', { command: 'git push --force origin feat/a' }, DAY), 10)
    assert.equal(a.deniedAt(lane, 'Bash', { command: 'rm -rf build' }, DAY), undefined)
    assert.equal(a.deniedAt(lane, 'Bash', { command: 'git push --force origin feat/b' }, DAY), undefined)
    assert.equal(a.deniedAt('C0TEST1:5.5#side-kagelet-docs', 'Bash', { command: 'git push --force origin feat/a' }, DAY), undefined)
    assert.equal(a.deniedAt('C0TEST2:9.9#side-kagelet-ops', 'Bash', { command: 'git push --force origin feat/a' }, DAY), undefined)
    assert.equal(deferredApprovals(openStore(':memory:')).deniedAt(lane, 'Bash', { command: 'x' }, 0), undefined)
    assert.equal(a.deniedAt(lane, 'Bash', { command: 'git push --force origin feat/a' }, 7 * DAY + 10), undefined)
  })

  test('a hold survives a restart, and lifting a kagelet\'s holds clears only that kagelet\'s', () => {
    const store = openStore(':memory:')
    const a = deferredApprovals(store, undefined, () => 7)
    for (const [id, key] of [['u1', 'C0TEST1:5.5#side-kagelet-ops'], ['u2', 'C0TEST1:5.5#side-kagelet-ops'], ['u3', 'C0TEST1:6.6#side-kagelet-docs']] as const) {
      a.add({ ...call, id, key, input: { command: `rm -rf ${id}` } }, 0)
      a.answer(id, 'deny', 1)
    }
    const after = deferredApprovals(store, undefined, () => 7)
    assert.equal(after.unhold('ops', 2), 2)
    assert.equal(after.deniedAt('C0TEST1:5.5#side-kagelet-ops', 'Bash', { command: 'rm -rf u1' }, 2), undefined)
    assert.equal(after.deniedAt('C0TEST1:6.6#side-kagelet-docs', 'Bash', { command: 'rm -rf u3' }, 2), 1)
    assert.equal(after.unhold('ops', 3), 0)
  })

  test('lifting counts only live holds, and a kagelet whose name ends like another keeps its own', () => {
    const DAY = 24 * HOUR
    const a = deferredApprovals(openStore(':memory:'), undefined, () => 7)
    for (const [id, key, at] of [['p1', 'C0TEST1:5.5#side-kagelet-ops', 0], ['p3', 'C0TEST1:6.6#side-kagelet-xops', 6 * DAY]] as const) {
      a.add({ ...call, id, key, input: { command: `rm -rf ${id}` } }, at)
      a.answer(id, 'deny', at)
    }
    assert.equal(a.unhold('ops', 10 * DAY), 0)
    assert.equal(a.deniedAt('C0TEST1:6.6#side-kagelet-xops', 'Bash', { command: 'rm -rf p3' }, 10 * DAY), 6 * DAY)
    assert.equal(a.unhold('xops', 10 * DAY), 1)
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
