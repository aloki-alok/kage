import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayEvents, eventRow, whoOf, type KageEvent } from './events.ts'

const ev = (at: string, who: string, chain = '', kind: KageEvent['kind'] = 'tool'): KageEvent => ({ at, kind, who, trace: 't1', chain, detail: '', transcript: '' })

test('an event row is one short line: no breaks, no tabs, cut at 200 characters', () => {
  const e = eventRow({ kind: 'report', who: 'deploys', trace: 't1', detail: `ok\n\tline two ${'x'.repeat(300)}` })
  assert.equal(e.detail.length, 200)
  assert.match(e.detail, /^ok line two x+$/)
  assert.equal(e.chain, '')
  assert.equal(e.transcript, '')
})

test('who an event is about: the kagelet for its lane, else the session key', () => {
  assert.equal(whoOf('C1:5.5#side-kagelet-deploys'), 'deploys')
  assert.equal(whoOf('C1:5.5'), 'C1:5.5')
  assert.equal(whoOf('dm'), 'dm')
})

test("a day's events, grouped by kagelet and chain, in time order; other days left out", () => {
  const all = [
    ev('2026-11-13T23:59:00.000Z', 'a'),
    ev('2026-11-14T09:00:02.000Z', 'b', 'c1'),
    ev('2026-11-14T09:00:00.000Z', 'a', 'c1'),
    ev('2026-11-14T10:00:00.000Z', 'a'),
    ev('2026-11-14T09:00:01.000Z', 'a', 'c1', 'run.end'),
    ev('2026-11-15T00:00:00.000Z', 'a'),
  ]
  const g = dayEvents(all, '2026-11-14')
  assert.deepEqual(g.map(x => [x.who, x.chain, x.events.map(e => e.at.slice(11, 19))]), [
    ['a', '', ['10:00:00']],
    ['a', 'c1', ['09:00:00', '09:00:01']],
    ['b', 'c1', ['09:00:02']],
  ])
})
