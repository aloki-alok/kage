import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { answerLines, decide, isLearnable, openTypedAsks, ownerWords, receiptLine, type TrustLine } from '../trust.ts'

const line = (o: Partial<TrustLine> = {}): TrustLine => ({ id: 'T1', who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', answer: 'yes', once: false, link: 'https://x/p', at: '2026-11-25T00:00:00.000Z', state: 'live', ...o })
const ask = { who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test' }

describe('the trust record decides from lines', () => {
  test('a live yes for the same teammate, kind and reach goes ahead and names its line', () => {
    assert.deepEqual(decide([line()], ask), { do: 'go', line: line() })
  })
  test('a teammate with no line is asked, and so is the same teammate on another reach or kind', () => {
    assert.deepEqual(decide([line()], { ...ask, who: 'UTEAM0002' }), { do: 'ask', why: 'no-line' })
    assert.deepEqual(decide([line()], { ...ask, reach: 'other.example.test' }), { do: 'ask', why: 'no-line' })
    assert.deepEqual(decide([line()], { ...ask, kind: 'site-read' }), { do: 'ask', why: 'no-line' })
  })
  test('a no always wins over a yes, whichever came last', () => {
    const no = line({ id: 'T2', answer: 'no' })
    assert.equal(decide([line(), no], ask).do, 'no')
    assert.equal(decide([no, line()], ask).do, 'no')
  })
  test('a once yes, a proposed line and a revoked line never cover an ask', () => {
    for (const l of [line({ once: true }), line({ state: 'proposed' }), line({ state: 'revoked' })]) assert.deepEqual(decide([l], ask), { do: 'ask', why: 'no-line' })
  })
  test('a revoked no no longer blocks', () => {
    assert.equal(decide([line(), line({ id: 'T2', answer: 'no', state: 'revoked' })], ask).do, 'go')
  })
  test('a never-learn kind asks even with a matching yes line, and so does an unknown kind', () => {
    for (const kind of ['money', 'delete', 'send-outside', 'prod-deploy', 'prod-write', 'prod-shell', 'secret', 'product', 'owner-shell'])
      assert.deepEqual(decide([line({ kind })], { ...ask, kind }), { do: 'ask', why: 'never-learn' }, kind)
    assert.deepEqual(decide([line({ kind: 'made-up' })], { ...ask, kind: 'made-up' }), { do: 'ask', why: 'unknown-kind' })
    assert.equal(isLearnable('prod-read'), true)
    assert.equal(isLearnable('prod-write'), false)
  })
})

describe('the owner answer becomes lines', () => {
  const open = [{ thread: 'C1:5.5', who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', would: 'ask' }]
  test('the owner words come from the hub task line, first line only', () => {
    assert.equal(ownerWords('Task from Sam: yes, once\n> [other:UTEAM0001 1.1] hi'), 'yes, once')
    assert.equal(ownerWords('From the owner, typed in the terminal: no'), 'no')
    assert.equal(ownerWords('Teammate task (UTEAM0001, Sam, not the owner): yes'), undefined)
  })
  test('yes makes a standing line, yes once makes a once line, no makes a no line', () => {
    assert.deepEqual(answerLines(open, 'yes'), [{ who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', answer: 'yes', once: false }])
    assert.equal(answerLines(open, 'Yes, once please')[0]!.once, true)
    assert.equal(answerLines(open, 'no')[0]!.answer, 'no')
  })
  test('an unclear answer, and an answer to a never-learn ask, write nothing', () => {
    assert.deepEqual(answerLines(open, 'what does that do?'), [])
    assert.deepEqual(answerLines([{ ...open[0]!, kind: 'prod-write' }], 'yes'), [])
  })
})

describe('typed asks in the waiting ledger', () => {
  const tsv = [
    '2026-11-25T00:00:00.000Z\topen\tC1:5.5\tlink\tRead prod?\tprod-read\tdb.example.test\tUTEAM0001\task',
    '2026-11-25T00:00:01.000Z\topen\tC1:5.5\tlink\tPlain ask?\t\t\t\t',
    '2026-11-25T00:00:02.000Z\topen\tC2:6.6\tlink\tOther?\tprod-read\tdb.example.test\tUTEAM0002\tgo',
  ].join('\n')
  test('only typed asks of the thread come back, with the would-decide', () => {
    assert.deepEqual(openTypedAsks(tsv, 'C1:5.5'), [{ thread: 'C1:5.5', who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', would: 'ask' }])
  })
})

describe('the daily receipt', () => {
  test('lists each step Kage took alone with its line, and is empty when none', () => {
    assert.equal(receiptLine([]), undefined)
    const text = receiptLine([['C1:5.5', 'UTEAM0001', 'prod-read', 'db.example.test', 'T1']])!
    assert.match(text, /Steps Kage took on its own \(1\)/)
    assert.match(text, /<@UTEAM0001>.*prod-read.*db\.example\.test.*T1/)
  })
})
