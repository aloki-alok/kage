import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repeats } from '../log-repeats.ts'

test('a line that repeats prints once, then its count when something else is logged', () => {
  const r = repeats(600_000)
  assert.deepEqual(r('pong late', 0), ['pong late'])
  assert.deepEqual(r('pong late', 1000), [])
  assert.deepEqual(r('pong late', 2000), [])
  assert.deepEqual(r('connected', 3000), ['(last line repeated 2 more times)', 'connected'])
  assert.deepEqual(r('pong late', 4000), ['pong late'])
})

test('a line still repeating after the window prints again with its count', () => {
  const r = repeats(600_000)
  r('pong late', 0)
  r('pong late', 1000)
  assert.deepEqual(r('pong late', 600_001), ['(last line repeated 1 more time)', 'pong late'])
  assert.deepEqual(r('pong late', 600_002), [])
})
