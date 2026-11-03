import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { openWaiting, postedBy, tsvRow } from './ledgers.ts'


describe('the ledgers', () => {
  test('a row keeps tabs and newlines out of its cells', () => {
    assert.equal(tsvRow(['a\tb', 'line1\nline2', 'ok']), 'a b\tline1 line2\tok\n')
  })
  test('an offer stays open until its thread gets a new task', () => {
    const rows = [
      tsvRow(['t1', 'open', 'C1:1.1', 'link1', 'Open a PR for lock_id?']),
      tsvRow(['t2', 'open', 'C2:2.2', 'link2', 'Restart the router?']),
      tsvRow(['t3', 'answered', 'C1:1.1', '', '']),
    ].join('')
    assert.deepEqual(openWaiting(rows), [{ when: 't2', link: 'link2', what: 'Restart the router?' }])
  })
  test('a new offer after an answer opens again', () => {
    const rows = [
      tsvRow(['t1', 'open', 'C1:1.1', 'l', 'first']),
      tsvRow(['t2', 'answered', 'C1:1.1', '', '']),
      tsvRow(['t3', 'open', 'C1:1.1', 'l', 'second']),
    ].join('')
    assert.deepEqual(openWaiting(rows).map(i => i.what), ['second'])
  })
  test('Kage may change only a message it posted, with the token it posted with', () => {
    const rows = [tsvRow(['t1', 'C1', '1.1', 'bot']), tsvRow(['t2', 'C2', '2.2', 'owner']), tsvRow(['t3', 'C1', '1.1', 'deleted'])].join('')
    assert.equal(postedBy(rows, 'C2', '2.2'), 'owner')
    assert.equal(postedBy(rows, 'C1', '1.1'), undefined)     // already deleted
    assert.equal(postedBy(rows, 'C1', '9.9'), undefined)     // someone else's message
    assert.equal(postedBy(tsvRow(['t1', 'C1', '1.1', 'bot']), 'C1', '1.1'), 'bot')
  })
  test('two offers in one thread both stay open', () => {
    const rows = [tsvRow(['t1', 'open', 'C1:1.1', 'l', 'a']), tsvRow(['t2', 'open', 'C1:1.1', 'l', 'b'])].join('')
    assert.deepEqual(openWaiting(rows).map(i => i.what), ['a', 'b'])
  })
})
