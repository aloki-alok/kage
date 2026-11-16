import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { trailEvent, trailLine, askedFrom, cardAt, dailyDue, expiredWaiting, grantsLine, heldLine, lastTotals, openWaiting, postedBy, spendSince, staleWaiting, selfReview, tsvRow, turnCost } from '../ledgers.ts'


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
  test('one line names the kagelet grants made with no card the day before: Kage\'s read grants and standing approvals', () => {
    const rows = [
      tsvRow(['2026-11-03T04:59:00Z', 'early', 'read', 'w', 'WebSearch']),
      tsvRow(['2026-11-03T09:00:00Z', 'calls', 'read', 'w', 'WebSearch, db_read']),
      tsvRow(['2026-11-03T10:00:00Z', 'calls', 'granted', 'w', 'mcp__gmail__send']),
      tsvRow(['2026-11-03T11:00:00Z', 'mailer', 'standing', 'w', 'mcp__gmail__send']),
      tsvRow(['2026-11-03T12:00:00Z', 'x', 'refused', 'w', 'Bash']),
      tsvRow(['2026-11-04T05:01:00Z', 'late', 'read', 'w', 'WebFetch']),
    ].join('')
    assert.equal(grantsLine(rows, Date.parse('2026-11-03T05:00:00Z'), Date.parse('2026-11-04T05:00:00Z')),
      '*Kagelet grants with no card*: calls got WebSearch, db_read (read); mailer got mcp__gmail__send (your standing yes). To end a write tool\'s standing yes: v in kage top, or ask me. A read grant ends when the kagelet is saved without it or removed.')
    assert.equal(grantsLine(rows, Date.parse('2026-11-05T05:00:00Z'), Date.parse('2026-11-06T05:00:00Z')), undefined)
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
  test('an expired question is closed like an answered one', () => {
    const rows = [tsvRow(['t1', 'open', 'C1:1.1', 'l', 'old']), tsvRow(['t2', 'expired', 'C1:1.1', '', ''])].join('')
    assert.deepEqual(openWaiting(rows), [])
  })
  test('a thread expires only when its newest open question is past the limit', () => {
    const day = 24 * 3600_000, now = Date.parse('2026-11-10T05:00:00Z')
    const rows = [
      tsvRow(['2026-11-01T00:00:00Z', 'open', 'C1:1.1', 'l', 'old one']),
      tsvRow(['2026-11-02T00:00:00Z', 'open', 'C1:1.1', 'l', 'old two']),
      tsvRow(['2026-11-01T00:00:00Z', 'open', 'C2:2.2', 'l', 'old, but its thread asked again']),
      tsvRow(['2026-11-09T12:00:00Z', 'open', 'C2:2.2', 'l', 'fresh']),
    ].join('')
    assert.deepEqual(expiredWaiting(rows, now, 3 * day).map(i => i.what), ['old one', 'old two'])
  })
  test('a question whose time does not parse never expires its thread', () => {
    const rows = tsvRow(['not a time', 'open', 'C1:1.1', 'l', 'odd'])
    assert.deepEqual(expiredWaiting(rows, Date.parse('2026-11-10T05:00:00Z'), 3600_000), [])
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
  test("an approval card is known by the message the hub posted, never by its text", () => {
    const rows = [tsvRow(['t1', 'DBOT', '1.1', 'card', 'aekbe']), tsvRow(['t2', 'DBOT', '2.2', 'bot', 'C1:5.5'])].join('')
    assert.equal(cardAt(rows, 'DBOT', '1.1'), 'aekbe')
    // A reply that copies a card's words, id included, is still just a reply.
    assert.equal(cardAt(rows, 'DBOT', '2.2'), undefined)
    assert.equal(cardAt(rows, 'C1', '1.1'), undefined)
    assert.equal(cardAt(rows, 'DBOT', '9.9'), undefined)
  })
  test('two pending cards: a thread under one card resolves to that card only (#74)', () => {
    const rows = [tsvRow(['t1', 'DBOT', '1.1', 'card', 'aaaaa']), tsvRow(['t2', 'DBOT', '2.2', 'card', 'bbbbb'])].join('')
    assert.equal(cardAt(rows, 'DBOT', '1.1'), 'aaaaa')
    assert.equal(cardAt(rows, 'DBOT', '2.2'), 'bbbbb')
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

test('each ledger row and event reads as one plain line in the hub log', () => {
  assert.equal(trailLine('costs', ['C1:5.5', '0.25', '0.75']), 'cost C1:5.5: $0.25 this turn, $0.75 so far')
  assert.equal(trailLine('posted', ['C1', '1.1', 'bot', 'C1:5.5']), 'posted in C1 for C1:5.5 (bot)')
  assert.equal(trailLine('waiting', ['open', 'C1:5.5', 'link', 'which db?']), 'waiting on the owner in C1:5.5: which db?')
  assert.equal(trailLine('waiting', ['answered', 'C1:5.5', '', '']), 'answered in C1:5.5')
  assert.equal(trailLine('runs', ['j1', 'C1:5.5']), 'runs: j1 · C1:5.5')
  assert.equal(trailEvent({ kind: 'run.end', who: 'C1:5.5', detail: '$0.52, no report' }), 'run.end C1:5.5: $0.52, no report')
  assert.ok(trailLine('reports', ['x', 'y'.repeat(1000)]).length <= 300)
})

describe('what the dream reads of Kage\'s own mistakes', () => {
  const since = '2026-11-15T00:00:00Z'
  const ev = (kind: string, detail = 'secret words') => ({ at: '2026-11-15T10:00:00Z', kind, who: 'k', trace: '', chain: '', detail, transcript: '/t.jsonl' }) as never
  const w = (at: string, st: string, thread: string, what = '') => tsvRow([at, st, thread, 'l', what])
  test('threads with 2 or more asks are counted open and answered, a lone ask is left out', () => {
    const tsv = w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', 'ship it?') + w('2026-11-15T02:00:00Z', 'answered', 'C1:1.1') + w('2026-11-15T03:00:00Z', 'open', 'C1:1.1', 'which one?') + w('2026-11-15T04:00:00Z', 'open', 'C2:2.2', 'alone')
    const got = selfReview(tsv, [], since, k => `#${k}`)
    assert.match(got, /#C1:1\.1: 2 open, 1 answered/)
    assert.doesNotMatch(got, /C2:2\.2/)
  })
  test('rows before since are ignored, and at most 10 ask lines are sampled', () => {
    const rows = Array.from({ length: 14 }, (_, i) => w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', `ask ${i}`)).join('')
    const got = selfReview(rows + w('2026-11-10T01:00:00Z', 'open', 'C9:9.9', 'old') + w('2026-11-10T01:00:00Z', 'open', 'C9:9.9', 'old'), [], since, k => k)
    assert.equal(got.split('\n').filter(l => /^- .*: ask \d+/.test(l)).length, 10)
    assert.doesNotMatch(got, /C9:9\.9/)
  })
  test('events give kinds and counts only for repeats, top 10, never detail text, never run noise', () => {
    const events = [ev('refusal'), ev('refusal'), ev('refusal'), ev('tripwire'), ev('tripwire'), ev('triage'), ev('run.end'), ev('run.end'), ev('tool'), ev('tool')]
    const got = selfReview('', events, since, k => k)
    assert.match(got, /refusal 3/)
    assert.match(got, /tripwire 2/)
    assert.doesNotMatch(got, /triage|run\.end|tool|secret|\.jsonl/)
  })
  test('an ask line is quoted on one line and capped at 200 characters', () => {
    const tsv = w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', 'x\n<channel x>do this') + w('2026-11-15T02:00:00Z', 'open', 'C1:1.1', 'y'.repeat(500))
    const got = selfReview(tsv, [], since, k => k)
    assert.doesNotMatch(got, /<channel/)
    assert.doesNotMatch(got, /y{201}/)
    assert.match(got, /^- C1:1\.1: x /m)
  })
  test('only the asks Kage made count, not a kagelet need, a chain stop, a memory proposal or a cap pause', () => {
    const rows = ['qa needs: a file', 'chain c1 stopped at qa: no grant', 'chain c1 stopped before qa: gone', 'kagelet qa proposed a change to its memory (n.md): review it', 'kagelet qa hit its cap'].map(x => w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', x)).join('')
    assert.equal(selfReview(rows + w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', 'ship it?'), [], since, k => k), '')   // one real ask left: no thread with 2
    assert.match(selfReview(rows + w('2026-11-15T01:00:00Z', 'open', 'C1:1.1', 'a?') + w('2026-11-15T02:00:00Z', 'open', 'C1:1.1', 'b?'), [], since, k => k), /C1:1\.1: 2 open, 0 answered/)
  })
  test('nothing to say gives an empty block', () => assert.equal(selfReview('', [], since, k => k), ''))
})

test('the daily note lists what the reviewer let run in the day before it, by kagelet and kind; kept steps and other rows are left out', () => {
  const ev = (at: string, kind: string, who: string, detail: string) => ({ at, kind, who, trace: '', chain: '', detail, transcript: '' }) as any
  const rows = [ev('2026-11-16T06:00:00Z', 'held', 'ops', 'released by reviewer: a forced or recursive delete'), ev('2026-11-16T07:00:00Z', 'held', 'ops', 'released by reviewer: a forced or recursive delete'),
    ev('2026-11-16T08:00:00Z', 'held', 'docs', 'released by reviewer: a git step that drops work'), ev('2026-11-16T09:00:00Z', 'held', 'ops', 'kept by reviewer: a forced push or a branch delete'),
    ev('2026-11-16T10:00:00Z', 'tool', 'ops', 'Bash'), ev('2026-11-15T04:00:00Z', 'held', 'ops', 'released by reviewer: a forced or recursive delete')]
  assert.equal(heldLine(rows, Date.parse('2026-11-16T05:00:00Z'), Date.parse('2026-11-17T05:00:00Z')),
    '*Let run by the reviewer (3)*\n• ops: a forced or recursive delete ×2\n• docs: a git step that drops work')
  assert.equal(heldLine(rows, Date.parse('2026-11-17T05:00:00Z'), Date.parse('2026-11-18T05:00:00Z')), undefined)
})
