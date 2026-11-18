import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meets, objectiveOf, readValue, scoreboard } from '../objective.ts'

test('an objective is three lines or none: a measure with no target, or a bad target, is an error', () => {
  const head = (o: Record<string, string>) => new Map(Object.entries(o))
  assert.equal(objectiveOf(head({})), undefined)
  assert.deepEqual(objectiveOf(head({ objective: 'Keep signup errors low', measure: './errors.sh', target: '<= 2' })),
    { objective: 'Keep signup errors low', measure: './errors.sh', target: { op: '<=', n: 2 } })
  assert.match((objectiveOf(head({ objective: 'x', measure: './m.sh' })) as { error: string }).error, /objective, measure and target/)
  for (const bad of ['about 2', '<= two', '=< 2', '2'])
    assert.match((objectiveOf(head({ objective: 'x', measure: './m.sh', target: bad })) as { error: string }).error, /target/, bad)
  assert.deepEqual((objectiveOf(head({ objective: 'x', measure: 'm', target: '>=500' })) as { target: unknown }).target, { op: '>=', n: 500 })
})

test('a measure prints exactly one value line; anything else is a failed measure, never a guessed number', () => {
  assert.equal(readValue('value: 3\n'), 3)
  assert.equal(readValue('value: -0.5'), -0.5)
  for (const bad of ['', 'value: 3\nvalue: 4', '3', 'value: three', 'errors 3', 'value: 3 errors', 'Value: 3']) assert.equal(readValue(bad), undefined, bad)
})

test('the target comparison', () => {
  assert.equal(meets(2, { op: '<=', n: 2 }), true)
  assert.equal(meets(3, { op: '<=', n: 2 }), false)
  assert.equal(meets(500, { op: '>', n: 500 }), false)
  assert.equal(meets(501, { op: '>', n: 500 }), true)
  assert.equal(meets(7, { op: '==', n: 7 }), true)
})

test('every run reads the scoreboard: the objective, the number against its target, and the trend, met or not', () => {
  const o = { objective: 'Two posts a week over 500 views', measure: 'm', target: { op: '>=' as const, n: 500 } }
  const met = scoreboard(o, [{ at: 0, value: 320 }, { at: 1, value: 510 }, { at: 2, value: 640 }])
  assert.match(met, /Two posts a week over 500 views/)
  assert.match(met, /640 \(target >= 500, met\)/)
  assert.match(met, /320, 510, 640/)
  assert.match(met, /Keep working/)
  assert.match(scoreboard(o, [{ at: 0, value: 120 }]), /120 \(target >= 500, not met\)/)
  assert.match(scoreboard(o, []), /not measured yet/)
  assert.match(scoreboard(o, [{ at: 0, value: 320 }, { at: 1, failed: 'exit 1' }]), /last measure failed \(exit 1\)/)
})
