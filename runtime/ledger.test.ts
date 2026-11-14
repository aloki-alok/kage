import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openLedgers, runEvents } from './ledger.ts'

const dir = () => mkdtempSync(`${tmpdir()}/kage-ledger-`)

describe('the ledgers live in kage.db, and read back as the TSV text the parsers already know', () => {
  test('a row added is read back as one TSV line, stamped with its time, in order, per ledger', () => {
    const d = dir()
    const l = openLedgers(d, () => '2026-11-09T00:00:00.000Z')
    l.add('waiting', ['open', 'C1:5.5', 'link', 'a\tquestion\nwith breaks'])
    l.add('posted', ['C1', '6.6', 'bot', 'C1:5.5'])
    l.add('waiting', ['answered', 'C1:5.5', '', ''])
    assert.equal(l.text('waiting'), '2026-11-09T00:00:00.000Z\topen\tC1:5.5\tlink\ta question with breaks\n2026-11-09T00:00:00.000Z\tanswered\tC1:5.5\t\t\n')
    assert.equal(l.text('posted'), '2026-11-09T00:00:00.000Z\tC1\t6.6\tbot\tC1:5.5\n')
  })
  test('two openers (the hub and a tmux pane) share the same ledgers', () => {
    const d = dir()
    const hub = openLedgers(d), pane = openLedgers(d)
    hub.add('posted', ['C1', '1.1', 'bot', 'k'])
    pane.add('posted', ['C1', '2.2', 'bot', 'k'])
    assert.equal(hub.text('posted').split('\n').filter(Boolean).length, 2)
  })
  test('an old TSV file is moved in once, ahead of new rows, then renamed so it is never read twice', () => {
    const d = dir()
    writeFileSync(`${d}/costs.tsv`, '2026-11-01T00:00:00.000Z\tC1:5.5\t0.5\t0.5\n')
    const l = openLedgers(d, () => '2026-11-09T00:00:00.000Z')
    l.add('costs', ['C1:5.5', '0.25', '0.75'])
    assert.equal(l.text('costs'), '2026-11-01T00:00:00.000Z\tC1:5.5\t0.5\t0.5\n2026-11-09T00:00:00.000Z\tC1:5.5\t0.25\t0.75\n')
    assert.equal(existsSync(`${d}/costs.tsv`), false)
    assert.equal(readdirSync(d).filter(f => f.startsWith('costs.tsv.imported-')).length, 1)
    assert.equal(openLedgers(d).text('costs').split('\n').filter(Boolean).length, 2)
  })
  test('a crash midway through an import neither loses nor doubles rows', () => {
    const d = dir()
    // Crashed after claiming the file, before the rows were committed: they come in on the next open.
    writeFileSync(`${d}/posted.tsv.importing-1-1`, '2026-11-01T00:00:00.000Z\tC1\t1.1\tbot\tk\n')
    assert.equal(openLedgers(d).text('posted').split('\n').filter(Boolean).length, 1)
    // Crashed after the commit, before the last rename: the marker stops a second copy.
    writeFileSync(`${d}/posted.tsv.importing-1-1`, '2026-11-01T00:00:00.000Z\tC1\t1.1\tbot\tk\n')
    assert.equal(openLedgers(d).text('posted').split('\n').filter(Boolean).length, 1)
    // ...and the leftover file is cleared, not retried on every start.
    assert.equal(existsSync(`${d}/posted.tsv.importing-1-1`), false)
  })
  test('a pane on old code that writes a fresh file after the move gets its rows moved in too', () => {
    const d = dir()
    writeFileSync(`${d}/waiting.tsv`, '2026-11-01T00:00:00.000Z\topen\tk\tl\tfirst\n')
    openLedgers(d).close()
    writeFileSync(`${d}/waiting.tsv`, '2026-11-02T00:00:00.000Z\topen\tk\tl\tsecond\n')
    assert.match(openLedgers(d).text('waiting'), /first\n.*second\n$/s)
  })
  test('a failed write is logged, never thrown: a ledger must not block a reply', () => {
    const l = openLedgers(dir())
    l.close()
    assert.doesNotThrow(() => l.add('posted', ['C1', '1.1', 'bot', 'k']))
  })
})

test('the hub store waits for a pane holding the write lock instead of failing', async () => {
  const { openStore } = await import('./store.ts')
  const { spawn } = await import('node:child_process')
  const d = dir()
  const store = openStore(`${d}/kage.db`)
  openLedgers(d).close()
  // Another process takes the write lock for 300 ms, as a pane writing a ledger row would.
  const holder = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(`${d}/kage.db`)}); db.exec('begin immediate'); console.log('locked'); setTimeout(() => { db.exec('commit'); process.exit(0) }, 300)`])
  await new Promise(r => holder.stdout.once('data', r))
  assert.equal(store.take('slack:CTEST:1.1', 'slack', 'x', 1), true)
  await new Promise(r => holder.once('exit', r))
})

describe('the event log lives in kage.db beside the ledgers', () => {
  test('an event is stored as one short row and read back by day', () => {
    let at = '2026-11-14T09:00:00.000Z'
    const l = openLedgers(dir(), () => at)
    l.event({ kind: 'run.start', who: 'deploys', trace: 't1', chain: 'c1', detail: 'job kagelet-deploys\nsecond line' })
    at = '2026-11-15T09:00:00.000Z'
    l.event({ kind: 'run.end', who: 'deploys', trace: 't1', detail: 'ok', transcript: '/p/s.jsonl' })
    assert.deepEqual(l.events('2026-11-14'), [{ at: '2026-11-14T09:00:00.000Z', kind: 'run.start', who: 'deploys', trace: 't1', chain: 'c1', detail: 'job kagelet-deploys second line', transcript: '' }])
    assert.equal(l.events('2026-11-15')[0]!.transcript, '/p/s.jsonl')
  })
  test('every grant row is also an event: a grant, or a refusal with its reason', () => {
    const l = openLedgers(dir(), () => '2026-11-14T09:00:00.000Z')
    l.add('grants', ['calls', 'granted', 'the owner said yes on the card'])
    l.add('grants', ['calls', 'refused', "not the owner's task"])
    assert.deepEqual(l.events('2026-11-14').map(e => [e.kind, e.who, e.detail]), [
      ['grant', 'calls', 'db_read: the owner said yes on the card'],
      ['refusal', 'calls', "db_read: not the owner's task"],
    ])
  })
  test('pruning folds each day older than the cutoff into one summary row, keeps newer days, and keeps summaries', () => {
    let at = '2026-10-01T09:00:00.000Z'
    const l = openLedgers(dir(), () => at)
    l.event({ kind: 'tool', who: 'a', trace: 't', detail: 'WebSearch' })
    l.event({ kind: 'tool', who: 'b', trace: 't', detail: 'WebFetch' })
    l.event({ kind: 'run.end', who: 'a', trace: 't', detail: 'ok' })
    at = '2026-11-14T09:00:00.000Z'
    l.event({ kind: 'tool', who: 'a', trace: 't', detail: 'WebSearch' })
    l.pruneEvents('2026-10-15T00:00:00.000Z')
    const old = l.events('2026-10-01')
    assert.equal(old.length, 1)
    assert.equal(old[0]!.kind, 'day-summary')
    assert.deepEqual(old[0]!.detail.split(', ').sort(), ['run.end 1', 'tool 2'])
    assert.equal(l.events('2026-11-14').length, 1)
    l.pruneEvents('2026-11-01T00:00:00.000Z')
    assert.equal(l.events('2026-10-01').length, 1)   // a summary is never folded again
  })
})

describe('pruning runs every hour, so it folds only whole days', () => {
  test('a cutoff in the middle of a day leaves that day alone; the next day folds it into one row', () => {
    let at = '2026-10-01T03:00:00.000Z'
    const l = openLedgers(dir(), () => at)
    l.event({ kind: 'tool', who: 'a', trace: 't', detail: 'WebSearch' })
    at = '2026-10-01T20:00:00.000Z'
    l.event({ kind: 'tool', who: 'a', trace: 't', detail: 'WebSearch' })
    l.pruneEvents('2026-10-01T10:00:00.000Z')
    l.pruneEvents('2026-10-01T21:00:00.000Z')
    assert.deepEqual(l.events('2026-10-01').map(e => e.kind), ['tool', 'tool'])
    l.pruneEvents('2026-10-02T05:00:00.000Z')
    assert.deepEqual(l.events('2026-10-01').map(e => [e.kind, e.detail]), [['day-summary', 'tool 2']])
  })
})

describe('runs: each event lands on the trace of the run its session is in', () => {
  test('a run starts once, its tool calls and report share its trace, and its end says whether it reported', () => {
    const l = openLedgers(dir(), () => '2026-11-14T09:00:00.000Z')
    let n = 0
    const runs = runEvents(l, () => `t${++n}`)
    const key = 'C1:5.5#side-kagelet-deploys'
    runs.start(key, 'scheduled')
    runs.start(key, 'owner')                 // a second task mid-run is the same run
    runs.emit(key, 'tool', 'WebSearch')
    runs.emit(key, 'report', 'ok')
    runs.end(key, '$0.10', '/p/s.jsonl')
    runs.end(key, '$0.00')                   // no run open: nothing
    runs.start('C1:5.5', 'owner')
    runs.end('C1:5.5', '$0.01')
    // A task sent mid-turn runs in the next turn, after the first one ended: its calls open a run of their own.
    runs.emit('C1:5.5', 'tool', 'WebFetch')
    runs.emit('C1:5.5', 'owner-note', '5 characters')   // a hub event opens none
    assert.deepEqual(l.events('2026-11-14').map(e => [e.kind, e.who, e.trace, e.detail, e.transcript]), [
      ['run.start', 'deploys', 't1', 'scheduled', ''],
      ['tool', 'deploys', 't1', 'WebSearch', ''],
      ['report', 'deploys', 't1', 'ok', ''],
      ['run.end', 'deploys', 't1', '$0.10, reported', '/p/s.jsonl'],
      ['run.start', 'C1:5.5', 't2', 'owner', ''],
      ['run.end', 'C1:5.5', 't2', '$0.01, no report', ''],
      ['run.start', 'C1:5.5', 't3', 'next turn', ''],
      ['tool', 'C1:5.5', 't3', 'WebFetch', ''],
      ['owner-note', 'C1:5.5', 't3', '5 characters', ''],
    ])
  })
  test('a scheduled run starts fresh: a run left open (its session cut) ends as cut first', () => {
    const l = openLedgers(dir(), () => '2026-11-14T09:00:00.000Z')
    let n = 0
    const runs = runEvents(l, () => `t${++n}`)
    runs.start('k', 'scheduled', { fresh: true, chain: 'c1' })
    runs.start('k', 'scheduled', { fresh: true })
    assert.deepEqual(l.events('2026-11-14').map(e => [e.kind, e.trace, e.chain, e.detail]), [
      ['run.start', 't1', 'c1', 'scheduled'],
      ['run.end', 't1', 'c1', 'cut: no result, no report'],
      ['run.start', 't2', '', 'scheduled'],
    ])
  })
})

test('a run tells the chain router whether it reported or had a call refused, and takes a chain id', () => {
  const runs = runEvents(openLedgers(dir(), () => '2026-11-14T09:00:00.000Z'), () => 't1')
  runs.start('k', 'scheduled', { fresh: true })
  runs.emit('k', 'refusal', 'Bash: no')
  assert.deepEqual(runs.of('k'), { trace: 't1', chain: '', reported: false, refused: true })
  runs.of('k')!.chain = 't1'
  runs.emit('k', 'handoff', 'to b, note: ok')
  runs.end('k', '$0.00')
  assert.equal(runs.of('k'), undefined)
})
