import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grade, swapDue } from '../shadow.ts'

const M = 60_000
const base = { twin: 'T', of: 'O', since: 0, windowMs: 30 * M }
const act = (at: number) => ({ job: 'O', at })
const says = (at: number, act = true) => ({ job: 'T', at, act })

test('the old job acted and the twin said act in the window: a match', () => {
  assert.deepEqual(grade({ ...base, acts: [act(100 * M)], verdicts: [says(110 * M)], now: 200 * M }), { matches: 1, misses: [] })
})

test('the old job acted and the twin never woke: a miss once the window has passed', () => {
  assert.deepEqual(grade({ ...base, acts: [act(100 * M)], verdicts: [], now: 131 * M }).misses, [{ at: 100 * M, kind: 'missed' }])
})

test('an act still inside its window is not judged yet', () => {
  assert.deepEqual(grade({ ...base, acts: [act(100 * M)], verdicts: [], now: 120 * M }), { matches: 0, misses: [] })
})

test('the twin said quiet when the old job acted: a miss', () => {
  assert.deepEqual(grade({ ...base, acts: [act(100 * M)], verdicts: [says(105 * M, false)], now: 200 * M }).misses, [{ at: 100 * M, kind: 'missed' }])
})

test('the twin said act and the old job did nothing: a false alarm', () => {
  assert.deepEqual(grade({ ...base, acts: [], verdicts: [says(100 * M)], now: 200 * M }).misses, [{ at: 100 * M, kind: 'false-alarm' }])
})

test('quiet on both sides counts for nothing', () => {
  assert.deepEqual(grade({ ...base, acts: [], verdicts: [says(100 * M, false), says(150 * M, false)], now: 300 * M }), { matches: 0, misses: [] })
})

test('one run that posted several parts counts once', () => {
  assert.deepEqual(grade({ ...base, acts: [act(100 * M), act(100 * M + 5_000), act(101 * M)], verdicts: [says(102 * M)], now: 300 * M }), { matches: 1, misses: [] })
})

test('the twin may answer before the old job posts', () => {
  assert.equal(grade({ ...base, acts: [act(100 * M)], verdicts: [says(80 * M)], now: 300 * M }).matches, 1)
})

test('a verdict just past the window does not pair', () => {
  const g = grade({ ...base, acts: [act(100 * M)], verdicts: [says(131 * M)], now: 300 * M })
  assert.equal(g.matches, 0)
  assert.deepEqual(g.misses.map(m => m.kind).sort(), ['false-alarm', 'missed'])
})

test('rows from other jobs and from before the twin was made are ignored', () => {
  const g = grade({ ...base, since: 50 * M, acts: [act(10 * M), { job: 'X', at: 100 * M }], verdicts: [says(20 * M), { job: 'Y', at: 100 * M, act: true }], now: 300 * M })
  assert.deepEqual(g, { matches: 0, misses: [] })
})

test('a swap is due at swapAfter matches with no miss, never with one', () => {
  assert.equal(swapDue({ matches: 3, misses: [] }, 3), true)
  assert.equal(swapDue({ matches: 2, misses: [] }, 3), false)
  assert.equal(swapDue({ matches: 9, misses: [{ at: 1, kind: 'missed' }] }, 3), false)
})
