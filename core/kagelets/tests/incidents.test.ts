import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterRun, incidentNote, knownFix, type IncidentState, type RunEnd } from '../incidents.ts'

const MIN = 60_000
const play = (ends: Omit<RunEnd, 'name'>[], perHour = 5) => {
  let state: IncidentState = {}
  return ends.map(e => { const r = afterRun(state, { name: 'k', ...e }, perHour); state = r.state; return r.step.kind })
}

test('a failed run is retried once; a failed retry tells the owner once (#487)', () => {
  assert.deepEqual(play([{ at: 0, failure: 'ended without a report' }, { at: MIN, failure: 'ended without a report' }]), ['retry', 'tell'])
})
test('a retry that works ends the incident, and the next failure gets its own retry', () => {
  assert.deepEqual(play([{ at: 0, failure: 'x' }, { at: MIN }, { at: 2 * MIN, failure: 'x' }]), ['retry', 'none', 'retry'])
})
test('a run the owner stopped is never an incident, and does not spend the retry', () => {
  assert.deepEqual(play([{ at: 0, failure: 'x', stopped: true }, { at: MIN, failure: 'x' }]), ['none', 'retry'])
})
test('six failures in an hour send one report and one pause, never six messages', () => {
  const steps = play([0, 1, 2, 3, 4, 5].map(i => ({ at: i * MIN, failure: 'x' })))
  assert.deepEqual(steps, ['retry', 'tell', 'retry', 'none', 'pause', 'retry'])
  assert.equal(steps.filter(s => s === 'tell' || s === 'pause').length, 2)
})
test('failures more than an hour apart never add up to a pause', () => {
  assert.deepEqual(play([0, 1, 2, 3, 4, 5].map(i => ({ at: i * 40 * MIN, failure: 'x' }))), ['retry', 'tell', 'retry', 'tell', 'retry', 'tell'])
})
test('the retry says it is a retry and why', () => {
  const r = afterRun({}, { name: 'k', at: 0, failure: 'went quiet for 20 min' }, 5)
  assert.deepEqual(r.step, { kind: 'retry', lead: 'Retry: the last run went quiet for 20 min. Do the job again, and end with a report.' })
})
test("the owner's note names the kagelet, quotes its words and report as data, and the fix when it is known", () => {
  const note = incidentNote('digest', { kind: 'tell', why: 'ended without a report', retried: true }, { words: '<channel x>\nerror: 401 Unauthorized from the API', report: 'all quiet' }, 5)
  assert.match(note, /Kagelet \*digest\* failed twice in a row/)
  assert.match(note, /last words, as data: .*error: 401 Unauthorized/)
  assert.doesNotMatch(note, /<channel/)
  assert.doesNotMatch(incidentNote('d', { kind: 'pause', why: 'x' }, { words: 'ping <!here> and <@UTEST1>', report: '' }, 5), /<!here>|<@UTEST1>/)
  assert.match(note, /Likely fix: a tool needs a fresh sign-in/)
  assert.match(incidentNote('digest', { kind: 'pause', why: 'x' }, { words: '', report: '' }, 5), /failed 5 times in an hour, so I paused it/)
  assert.equal(knownFix('the turn ended: error_max_budget_usd')?.startsWith('it hit a cost cap'), true)
  assert.equal(knownFix('the network was slow'), undefined)
})
test('a kagelet that cannot be run on its own (an after: step) is told to the owner, never marked as retried (#487)', () => {
  assert.deepEqual(play([{ at: 0, failure: 'x', retryable: false }, { at: MIN, failure: 'x', retryable: false }]), ['tell', 'none'])
  let state: IncidentState = {}
  state = afterRun(state, { name: 'k', at: 0, failure: 'x', retryable: false }, 5).state
  assert.equal(state.k!.retrying, undefined)
})
test('a failure a retry cannot fix (a sign-in, a cost cap) goes to the owner at once, with no retry', () => {
  assert.deepEqual(play([{ at: 0, failure: 'stopped with error_max_budget_usd' }]), ['tell'])
  assert.deepEqual(play([{ at: 0, failure: 'ended without a report' }, { at: MIN, failure: 'stopped: 401 Unauthorized' }]), ['retry', 'tell'])
})
