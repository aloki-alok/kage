import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markSeen, seenUpTo, tsAfter } from '../thread-delta.ts'

test('a mark counts only for the same session id with a transcript to resume', () => {
  const mark = { id: 'S1', ts: '100.5' }
  assert.equal(seenUpTo(mark, { id: 'S1', resumable: true }), '100.5')
  assert.equal(seenUpTo(mark, { id: 'S2', resumable: true }), undefined)
  assert.equal(seenUpTo(mark, { id: 'S1', resumable: false }), undefined)
  assert.equal(seenUpTo(mark, undefined), undefined)
  assert.equal(seenUpTo(undefined, { id: 'S1', resumable: true }), undefined)
})

test('Slack ts compare as split numbers, so a shorter fraction is not read as larger', () => {
  assert.equal(tsAfter('100.10', '100.9'), true)
  assert.equal(tsAfter('100.9', '100.10'), false)
  assert.equal(tsAfter('101.0', '100.999'), true)
  assert.equal(tsAfter('100.5', '100.5'), false)
})

test('a new mark replaces the key and drops marks older than 30 days', () => {
  const day = 86_400
  const marks = { old: { id: 'A', ts: `${1_000_000 - 31 * day}.1` }, recent: { id: 'B', ts: `${1_000_000 - day}.1` }, k: { id: 'C', ts: '1.1' } }
  assert.deepEqual(markSeen(marks, 'k', { id: 'D', ts: '1000000.2' }), { recent: { id: 'B', ts: `${1_000_000 - day}.1` }, k: { id: 'D', ts: '1000000.2' } })
})
