import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { askedFrom, dailyDue, lastTotals, openWaiting, postedBy, spendSince, staleWaiting, tsvRow, turnCost } from './ledgers.ts'


describe('the daily note of what waits on the owner', () => {
  const day = 24 * 3600_000
  const now = Date.parse('2026-11-04T05:10:00Z')
  test('only questions open for a day or more are in it', () => {
    const rows = [
      tsvRow(['2026-11-02T09:00:00Z', 'open', 'C1:1.1', 'l1', 'old']),
      tsvRow(['2026-11-04T01:00:00Z', 'open', 'C2:2.2', 'l2', 'new']),
    ].join('')
    assert.deepEqual(staleWaiting(rows, now, day).map(i => i.what), ['old'])
  })
  test('it is due once a day, from 10:30 IST (05:00 UTC)', () => {
    assert.equal(dailyDue(Date.parse('2026-11-04T04:59:00Z'), undefined), undefined)
    assert.equal(dailyDue(now, undefined), '2026-11-04')
    assert.equal(dailyDue(now, '2026-11-04'), undefined)
    assert.equal(dailyDue(now, '2026-11-03'), '2026-11-04')
  })
})

describe('the ledgers', () => {
  test('a row keeps tabs and newlines out of its cells', () => {
    assert.equal(tsvRow(['a\tb', 'line1\nline2', 'ok']), 'a b\tline1 line2\tok\n')
  })
  test('a question stays open until its thread gets a new task', () => {
    const rows = [
      tsvRow(['t1', 'open', 'C1:1.1', 'link1', 'Open a PR for lock_id?']),
      tsvRow(['t2', 'open', 'C2:2.2', 'link2', 'Restart the router?']),
      tsvRow(['t3', 'answered', 'C1:1.1', '', '']),
    ].join('')
    assert.deepEqual(openWaiting(rows), [{ when: 't2', thread: 'C2:2.2', link: 'link2', what: 'Restart the router?' }])
  })
  test('a new question after an answer opens again', () => {
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
  test('an answer under a private ask belongs to the thread that asked', () => {
    const rows = [
      tsvRow(['t1', 'DTEST', '5.5', 'bot', 'CTEST:1.1']),        // private ask from a channel thread
      tsvRow(['t2', 'DTEST', '6.6', 'bot', 'DTEST:6.6']),        // the DM thread's own reply
      tsvRow(['t3', 'DTEST', '7.7', 'bot', 'dm']),               // the rolling DM
      tsvRow(['t4', 'DTEST', '8.8', 'bot']),                     // row from before keys were logged
      tsvRow(['t5', 'COTHER', '4.4', 'bot', 'CTEST:9.9']),       // same ts, another channel
      tsvRow(['t6', 'DTEST', '3.3', 'bot', 'mail:abc']),         // private ask from an email thread
      tsvRow(['t7', 'DTEST', '2.2', 'bot', 'voice:xyz']),        // private ask from a call
    ].join('')
    assert.equal(askedFrom(rows, 'DTEST', '3.3'), undefined)  // not a Slack thread: stays a DM task
    assert.equal(askedFrom(rows, 'DTEST', '2.2'), undefined)
    assert.equal(askedFrom(rows, 'DTEST', '5.5'), 'CTEST:1.1')
    assert.equal(askedFrom(rows, 'DTEST', '6.6'), undefined)
    assert.equal(askedFrom(rows, 'DTEST', '7.7'), undefined)
    assert.equal(askedFrom(rows, 'DTEST', '8.8'), undefined)
    assert.equal(askedFrom(rows, 'DTEST', '4.4'), undefined)  // not Kage's message in the DM
  })
  test('two questions in one thread both stay open', () => {
    const rows = [tsvRow(['t1', 'open', 'C1:1.1', 'l', 'a']), tsvRow(['t2', 'open', 'C1:1.1', 'l', 'b'])].join('')
    assert.deepEqual(openWaiting(rows).map(i => i.what), ['a', 'b'])
  })
})

describe('the cost ledger', () => {
  test('a turn costs what the running total grew by; a total that went down started over', () => {
    assert.equal(turnCost(undefined, 0.4), 0.4)
    assert.equal(turnCost(0.4, 0.75), 0.35)
    assert.equal(turnCost(0.75, 0.1), 0.1)                       // /clear or a fresh session
    assert.equal(turnCost(0.1, 0.3), 0.2)                        // no float dust
    assert.equal(turnCost(5, 0), undefined)                      // a crash result reports zeros: not a turn
    assert.equal(turnCost(5, Number.NaN), undefined)
  })
  test('a resumed conversation with no row yet starts a baseline, not a turn that cost its whole life', () => {
    assert.equal(turnCost(undefined, 51.8, true), 0)
    assert.equal(turnCost(51.8, 52.1, true), 0.3)               // after the baseline, turns count as usual
    assert.equal(turnCost(undefined, 0.4, false), 0.4)           // a new conversation's first turn is all its own
  })
  test('the last total per thread comes back from the file, so a restart does not count a turn twice', () => {
    const tsv = [tsvRow(['2026-11-06T01:00:00Z', 'C1:1.1', '0.4', '0.4']), tsvRow(['2026-11-06T02:00:00Z', 'C1:1.1', '0.35', '0.75']), tsvRow(['2026-11-06T02:00:00Z', 'dm', '0.2', '0.2'])].join('')
    assert.deepEqual(lastTotals(tsv), new Map([['C1:1.1', 0.75], ['dm', 0.2]]))
  })
  test('spend per thread since a time, most expensive first, with its turns', () => {
    const tsv = [
      tsvRow(['2026-11-04T01:00:00Z', 'dm', '9', '9']),
      tsvRow(['2026-11-06T01:00:00Z', 'C1:1.1', '0.4', '0.4']),
      tsvRow(['2026-11-06T02:00:00Z', 'C1:1.1', '0.35', '0.75']),
      tsvRow(['2026-11-06T02:00:00Z', 'dm', '0.2', '9.2']),
    ].join('')
    assert.deepEqual(spendSince(tsv, Date.parse('2026-11-05T00:00:00Z')), [{ key: 'C1:1.1', usd: 0.75, turns: 2 }, { key: 'dm', usd: 0.2, turns: 1 }])
  })
})
