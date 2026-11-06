import { test } from 'node:test'
import assert from 'node:assert/strict'
import { socketWatch } from './socket-watch.ts'

const MIN = 60_000
test('a socket down for 3 minutes is restarted, then given 3 more minutes before the next try', () => {
  const w = socketWatch({ downMs: 3 * MIN })
  w.connected()
  w.down(10_000)
  assert.equal(w.check(10_000 + 2 * MIN), 'wait')
  assert.equal(w.check(10_000 + 3 * MIN), 'restart')
  assert.equal(w.check(10_000 + 4 * MIN), 'wait')
  assert.match(w.check(10_000 + 6 * MIN), /^restart/)
})
test('the owner hears once, after the second restart did not bring it back', () => {
  const w = socketWatch({ downMs: 3 * MIN })
  w.down(0)
  assert.equal(w.check(3 * MIN), 'restart')
  assert.equal(w.check(6 * MIN), 'restart and tell')
  assert.equal(w.check(9 * MIN), 'restart')
})
test('a connection clears it all; a socket that is up is never touched however quiet', () => {
  const w = socketWatch({ downMs: 3 * MIN })
  w.down(0)
  w.check(3 * MIN)
  w.connected()
  assert.equal(w.check(60 * MIN), 'ok')
  w.down(61 * MIN)
  assert.equal(w.check(64 * MIN), 'restart')
  assert.equal(w.check(67 * MIN), 'restart and tell')
})
test('before the first connection the clock starts at the first check', () => {
  const w = socketWatch({ downMs: 3 * MIN })
  assert.equal(w.check(100), 'wait')
  assert.equal(w.check(100 + 3 * MIN), 'restart')
})
