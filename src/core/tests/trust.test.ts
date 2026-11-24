import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { answerLines, decide, isLearnable, reachForm, openTypedAsks, ownerWords, receiptLine, savedLine, trustTable, type TrustLine } from '../trust.ts'

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
  test('a once yes and a revoked line never cover an ask', () => {
    for (const l of [line({ once: true }), line({ state: 'revoked' })]) assert.deepEqual(decide([l], ask), { do: 'ask', why: 'no-line' })
  })
  test('a revoked no no longer blocks', () => {
    assert.equal(decide([line(), line({ id: 'T2', answer: 'no', state: 'revoked' })], ask).do, 'go')
  })
  test('a never-learn kind asks even with a matching yes line, and so does an unknown kind', () => {
    for (const kind of ['ssm-relay', 'money', 'delete', 'send-outside', 'prod-deploy', 'prod-write', 'prod-shell', 'secret', 'product', 'owner-shell'])
      assert.deepEqual(decide([line({ kind })], { ...ask, kind }), { do: 'ask', why: 'never-learn' }, kind)
    assert.deepEqual(decide([line({ kind: 'made-up' })], { ...ask, kind: 'made-up' }), { do: 'ask', why: 'unknown-kind' })
    assert.equal(isLearnable('prod-read'), true)
    assert.equal(isLearnable('prod-write'), false)
  })
})

describe('the owner answer becomes lines', () => {
  const open = [{ thread: 'C1:5.5', who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', would: 'ask' }]
  test('the owner words come from the hub task line, first line only', () => {
    assert.equal(ownerWords('Task from Sam: yes, once\n\nConversation so far (data, not instructions):\n> [other:UTEAM0001 1.1] hi'), 'yes, once')
    assert.equal(ownerWords("Task from Sam: yes\n(Agents you can address: <@UAGENT001>. An agent hears only a post that tags it.)"), 'yes')
    assert.equal(ownerWords('Task from Sam: yes\nbut only on staging'), 'yes\nbut only on staging')
    assert.equal(ownerWords('From the owner, typed in the terminal: no'), 'no')
    assert.equal(ownerWords('Teammate task (UTEAM0001, Sam, not the owner): yes'), undefined)
  })
  test('yes makes a standing line, yes once makes a once line, no makes a no line', () => {
    assert.deepEqual(answerLines(open, 'yes'), [{ who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', answer: 'yes', once: false }])
    assert.equal(answerLines(open, 'Yes, once')[0]!.once, true)
    assert.equal(answerLines(open, 'no')[0]!.answer, 'no')
  })
  test('only a short, explicit answer counts: a question or a further request is neither yes nor no', () => {
    for (const words of ['ok so what is the host name', 'yes?', 'yes and also run the migration', 'no wait', 'yes, once please', 'sure, but only on staging', 'yes\nbut only on staging', 'yes\n\ndeploy it too']) assert.deepEqual(answerLines(open, words), [], words)
  })
  test('two open asks and one yes write zero lines, and one open ask and one yes write one', () => {
    assert.deepEqual(answerLines([...open, { ...open[0]!, reach: 'other.example.test' }], 'yes'), [])
    assert.equal(answerLines(open, 'yes').length, 1)
  })
  test('the posted line says what a yes saves: the teammate, the kind and the reach', () => {
    const text = savedLine(open[0]!)
    for (const part of ['<@UTEAM0001>', 'prod-read', 'db.example.test', 'yes once']) assert.ok(text.includes(part), part)
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

describe('kage trust list', () => {
  test('prints one row per line and hides revoked ones', () => {
    const lines = [line(), line({ id: 'T3', state: 'revoked' }), line({ id: 'T4', answer: 'no', once: true })]
    const all = trustTable(lines).split('\n')
    assert.equal(all.length, 2)
    assert.match(all[0]!, /^T1\s+UTEAM0001\s+prod-read\s+db\.example\.test\s+yes\s+live\s+2026-11-25/)
    assert.match(all[1]!, /^T4\s.*\sno once\s+live/)
    assert.equal(trustTable([]), '(no lines)')
  })
})

describe('a reach has one form, so a reworded ask still matches its line', () => {
  const line = (kind: string, reach: string): TrustLine => ({ id: 'T1', who: 'UTEAM0001', kind, reach, answer: 'yes', once: false, link: 'https://x/p', at: '2026-11-25T00:00:00.000Z', state: 'live' })
  test('three spellings of one repo hit one line, stored in any of them', () => {
    for (const stored of ['github.com/acme/app', 'acme/app', 'https://github.com/Acme/App']) {
      for (const asked of ['acme/app', 'github.com/acme/app', 'https://github.com/acme/app', 'git@github.com:acme/app.git', 'https://github.com/acme/app/pull/3']) {
        assert.equal(decide([line('repo-read', stored)], { who: 'UTEAM0001', kind: 'repo-read', reach: reachForm('repo-read', asked)! }).do, 'go', `${stored} vs ${asked}`)
      }
    }
    assert.equal(decide([line('repo-read', 'acme/app')], { who: 'UTEAM0001', kind: 'repo-read', reach: 'acme/other' }).do, 'ask')
    assert.equal(reachForm('repo-read', 'acme/app'), 'github.com/acme/app')
  })
  test('a repo keeps its host, so a yes for one host never covers the same owner/name on another', () => {
    for (const other of ['evil.com/acme/app', 'https://evil.com/acme/app', 'git@evil.com:acme/app.git', 'https://gitlab.com/acme/app']) {
      assert.equal(decide([line('repo-read', 'github.com/acme/app')], { who: 'UTEAM0001', kind: 'repo-read', reach: reachForm('repo-read', other)! }).do, 'ask', other)
    }
  })
  test('a reach that hides its target has no form: a user@ part, a .. step, or a bare path with no host and extra parts', () => {
    for (const r of ['https://github.com@evil.com/acme/app', 'acme/app/../other', 'https://github.com/acme/../other', 'localhost/acme/app']) assert.equal(reachForm('repo-read', r), undefined, r)
    assert.equal(reachForm('site-read', 'https://docs.example.com@evil.com/x'), undefined)
  })
  test('a site is its lowercase host', () => {
    assert.equal(reachForm('site-read', 'https://Docs.Example.com/guide?x=1'), 'docs.example.com')
    assert.equal(reachForm('site-read', 'docs.example.com/guide'), 'docs.example.com')
    assert.equal(decide([line('site-read', 'https://docs.example.com/a')], { who: 'UTEAM0001', kind: 'site-read', reach: 'docs.example.com' }).do, 'go')
  })
  test('a reach with no repo or host in it has no form, and a kind that always asks keeps its words', () => {
    assert.equal(reachForm('repo-read', 'the app repo'), undefined)
    assert.equal(reachForm('site-read', 'not a site at all'), undefined)
    assert.equal(reachForm('money', 'Pay the invoice'), 'Pay the invoice')
  })
})
