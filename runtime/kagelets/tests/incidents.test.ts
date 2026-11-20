import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletIncidents } from '../incidents.ts'
import { openStore } from '../../store.ts'

const MIN = 60_000
const LANE = 'C1:5.5#side-kagelet-digest'
function setup(retryable = (_name: string) => true) {
  const store = openStore(':memory:')
  const did: string[] = []
  const lanes = new Map<string, { busy: boolean; last: number; trace?: string }>()
  const inc = kageletIncidents({
    store, perHour: () => 5, stallMs: () => 20 * MIN, retryable,
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
test('a run the owner stopped is never an incident', () => {
  const t = setup()
  t.inc.stopped(LANE, 'run1')
  t.inc.ended(LANE, 'ended without a report', '', MIN, 'run1')
  assert.deepEqual(t.did, [])
  t.inc.ended(LANE, 'ended without a report', '', 2 * MIN, 'run2')
  assert.equal(t.did.length, 1)
})
test('a busy lane quiet for turnStallMinutes is cut and counts as a failure, once; a quiet idle lane is left alone', () => {
  const t = setup()
  t.lanes.set(LANE, { busy: true, last: 0, trace: 'run1' })
  t.lanes.set('C2:1.1#side-kagelet-other', { busy: false, last: 0, trace: 'run9' })
  t.inc.stalls(19 * MIN)
  assert.deepEqual(t.did, [])
  t.inc.stalls(21 * MIN)
  t.inc.ended(LANE, 'ended without a report', '', 21 * MIN, 'run1')
  assert.deepEqual(t.did, [`cut ${LANE}`, 'retry digest: Retry: the last run went quiet for 20 min. Do the job again, and end with a report.'])
})
test('a kagelet with no schedule of its own is never retried: its failure goes to the owner', () => {
  const t = setup(() => false)
  t.inc.ended(LANE, 'ended without a report', '', 0, 'run1')
  assert.deepEqual(t.did, ['dm Kagelet *digest* failed: ended without a report.'])
})
test("a stall cut hides only the cut run's own end, never the retry's failure that follows (#487)", () => {
  const t = setup()
  t.lanes.set(LANE, { busy: true, last: 0, trace: 'run1' })
  t.inc.stalls(21 * MIN)
  t.inc.ended(LANE, 'ended without a report', '', 21 * MIN, 'run1')
  t.inc.ended(LANE, 'ended without a report', '', 25 * MIN, 'run2')
  assert.deepEqual(t.did.map(d => d.split(': ')[0]), [`cut ${LANE}`, 'retry digest', 'dm Kagelet *digest* failed twice in a row, once on a retry'])
})
test("a stall cut whose own result never comes does not hide the retry's failure", () => {
  const t = setup()
  t.lanes.set(LANE, { busy: true, last: 0, trace: 'run1' })
  t.inc.stalls(21 * MIN)
  t.inc.ended(LANE, 'ended without a report', '', 25 * MIN, 'run2')
  assert.match(t.did.at(-1)!, /^dm Kagelet \*digest\* failed twice in a row/)
})
test("an owner's stop hides only the run it stopped", () => {
  const t = setup()
  t.inc.stopped(LANE, 'run1')
  t.inc.ended(LANE, 'ended without a report', '', MIN, 'run2')
  assert.equal(t.did.length, 1)
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
  const again = kageletIncidents({ store: t.store, perHour: () => 5, stallMs: () => 20 * MIN, retryable: () => true, retry: () => t.did.push('retry'), pause: () => {}, say: x => t.did.push(`dm ${x.split('\n')[0]}`), last: () => ({ words: '', report: '' }), live: () => [], cut: () => {} })
  again.ended(LANE, 'ended without a report', '', MIN)
  assert.match(t.did.at(-1)!, /^dm Kagelet \*digest\* failed twice in a row/)
})
