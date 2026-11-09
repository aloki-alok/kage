import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openLedgers } from './ledger.ts'

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
