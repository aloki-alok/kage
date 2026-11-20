import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletIncidents } from '../incidents.ts'
import { openStore } from '../../store.ts'

const MIN = 60_000
const LANE = 'C1:5.5#side-kagelet-digest'
function setup() {
  const store = openStore(':memory:')
  const did: string[] = []
  const lanes = new Map<string, { busy: boolean; last: number }>()
  const inc = kageletIncidents({
    store, perHour: () => 5, stallMs: () => 20 * MIN,
    retry: (name, lead) => did.push(`retry ${name}: ${lead}`),
    pause: name => did.push(`pause ${name}`),
    say: text => did.push(`dm ${text.split('\n')[0]}`),
    last: () => ({ words: 'last words', report: 'last report' }),
    live: () => [...lanes].map(([key, l]) => ({ key, ...l })),
    cut: key => { did.push(`cut ${key}`); lanes.delete(key) },
  })
  return { inc, did, lanes, store }
}

test('a fake runner that never reports gets one retry, then one DM (#487)', () => {
  const t = setup()
  t.inc.ended(LANE, 'ended without a report', '', 0)
  t.inc.ended(LANE, 'ended without a report', '', MIN)
  assert.deepEqual(t.did, [
    'retry digest: Retry: the last run ended without a report. Do the job again, and end with a report.',
    'dm Kagelet *digest* failed twice in a row, once on a retry: ended without a report.',
  ])
})
test('six failures in an hour pause the kagelet with one DM, not six', () => {
  const t = setup()
  for (let i = 0; i < 6; i++) t.inc.ended(LANE, 'ended without a report', '', i * MIN)
  assert.deepEqual(t.did.filter(d => d.startsWith('dm') || d.startsWith('pause')), [
    'dm Kagelet *digest* failed twice in a row, once on a retry: ended without a report.',
    'pause digest',
    'dm Kagelet *digest* failed 5 times in an hour, so I paused it: ended without a report. Resume it from kage top or ask me when it is fixed.',
  ])
})
test('a run the owner stopped is never an incident; a stop is forgotten after 10 minutes', () => {
  const t = setup()
  t.inc.stopped(LANE, 0)
  t.inc.ended(LANE, 'ended without a report', '', MIN)
  assert.deepEqual(t.did, [])
  t.inc.stopped(LANE, 0)
  t.inc.ended(LANE, 'ended without a report', '', 11 * MIN)
  assert.equal(t.did.length, 1)
})
test('a busy lane quiet for turnStallMinutes is cut and counts as a failure, once; a quiet idle lane is left alone', () => {
  const t = setup()
  t.lanes.set(LANE, { busy: true, last: 0 })
  t.lanes.set('C2:1.1#side-kagelet-other', { busy: false, last: 0 })
  t.inc.stalls(19 * MIN)
  assert.deepEqual(t.did, [])
  t.inc.stalls(21 * MIN)
  t.inc.ended(LANE, 'ended without a report', '', 21 * MIN)
  assert.deepEqual(t.did, [`cut ${LANE}`, 'retry digest: Retry: the last run went quiet for 20 min. Do the job again, and end with a report.'])
  t.lanes.set(LANE, { busy: true, last: 40 * MIN })
  t.inc.stalls(70 * MIN)
  t.inc.ended(LANE, 'ended without a report', '', 90 * MIN)
  assert.match(t.did.at(-1)!, /^retry digest: Retry: the last run ended without a report/, 'a cut whose result never came does not hide the next real failure')
})
test('a run that ends well clears the retry, and only kagelet lanes count', () => {
  const t = setup()
  t.inc.ended(LANE, 'ended without a report', '', 0)
  t.inc.ended(LANE, undefined, '', MIN)
  t.inc.ended(LANE, 'ended without a report', '', 2 * MIN)
  t.inc.ended('C1:5.5', 'ended without a report', '', 3 * MIN)
  assert.deepEqual(t.did.map(d => d.split(':')[0]), ['retry digest', 'retry digest'])
})
test('the incident state outlives a hub restart', () => {
  const t = setup()
  t.inc.ended(LANE, 'ended without a report', '', 0)
  const again = kageletIncidents({ store: t.store, perHour: () => 5, stallMs: () => 20 * MIN, retry: () => t.did.push('retry'), pause: () => {}, say: x => t.did.push(`dm ${x.split('\n')[0]}`), last: () => ({ words: '', report: '' }), live: () => [], cut: () => {} })
  again.ended(LANE, 'ended without a report', '', MIN)
  assert.match(t.did.at(-1)!, /^dm Kagelet \*digest\* failed twice in a row/)
})
