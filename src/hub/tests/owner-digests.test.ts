import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openLedgers } from '../../runtime/ledger.ts'
import { openWaiting } from '../../core/ledgers.ts'
import { ownerDigests } from '../owner-digests.ts'
import type { Store } from '../../runtime/store.ts'

const now = Date.parse('2026-11-10T05:10:00Z')
function setup(sent: boolean) {
  const dir = mkdtempSync(`${tmpdir()}/digests-`)
  let at = '2026-11-06T00:00:00Z'
  const ledgers = openLedgers(dir, () => at)
  ledgers.add('waiting', ['open', 'C1:1.1', 'l1', 'Merge the old PR?'])
  at = '2026-11-08T12:00:00Z'
  ledgers.add('waiting', ['open', 'C2:2.2', 'l2', 'Run the new check?'])
  const notes: string[] = []
  const d = ownerDigests({ dir, ledgers, store: {} as Store, placeOf: k => k, costTracked: false, expireHours: () => 72,
    notify: async t => { notes.push(t); return sent } })
  return { d, ledgers, notes }
}

describe('the daily note drops a question nobody answered in time', () => {
  test('a question past the limit is named once in the note, then closed', async () => {
    const s = setup(true)
    await s.d.dailyNote(now)
    assert.match(s.notes[0]!, /Dropped after 72 h\. Reply in its thread if one still matters \(1\)[\s\S]*Merge the old PR\?/)
    assert.match(s.notes[0]!, /Still waiting on you \(1\)[\s\S]*Run the new check\?/)
    assert.doesNotMatch(s.notes[0]!.split('Still waiting')[1]!.split('Dropped')[0]!, /Merge the old PR/)
    assert.deepEqual(openWaiting(s.ledgers.text('waiting')).map(i => i.what), ['Run the new check?'])
  })
  test('a thread that asks again while the note posts stays open', async () => {
    const dir = mkdtempSync(`${tmpdir()}/digests-`)
    const ledgers = openLedgers(dir, () => '2026-11-06T00:00:00Z')
    ledgers.add('waiting', ['open', 'C1:1.1', 'l1', 'Merge the old PR?'])
    const late = openLedgers(dir, () => '2026-11-10T05:09:00Z')
    const d = ownerDigests({ dir, ledgers, store: {} as Store, placeOf: k => k, costTracked: false, expireHours: () => 72,
      notify: async () => { late.add('waiting', ['open', 'C1:1.1', 'l1', 'And the new one?']); return true } })
    await d.dailyNote(now)
    assert.deepEqual(openWaiting(ledgers.text('waiting')).map(i => i.what), ['Merge the old PR?', 'And the new one?'])
  })
  test('a note that failed to post closes nothing, so the retry names it again', async () => {
    const s = setup(false)
    await s.d.dailyNote(now)
    assert.equal(openWaiting(s.ledgers.text('waiting')).length, 2)
  })
})

describe('each daily note leaves one line in kage logs (#433)', () => {
  test('a note that went out says what it held, and a day with nothing to say says so', async () => {
    const s = setup(true)
    await s.d.dailyNote(now)
    const quiet = setup(true)
    quiet.ledgers.add('waiting', ['answered', 'C1:1.1', '', ''])
    quiet.ledgers.add('waiting', ['answered', 'C2:2.2', '', ''])
    await quiet.d.dailyNote(now)
    const note = (l: typeof s.ledgers) => l.events('2026-11-08').filter(e => e.kind === 'daily-note').map(e => e.detail)
    assert.deepEqual(note(s.ledgers), ['2026-11-10 sent: 1 waiting, 1 dropped'])
    assert.deepEqual(note(quiet.ledgers), ['2026-11-10 nothing to say'])
  })
  test('a note that did not go out leaves no line, so the next run tries again', async () => {
    const s = setup(false)
    await s.d.dailyNote(now)
    assert.deepEqual(s.ledgers.events('2026-11-08').filter(e => e.kind === 'daily-note'), [])
  })
})
