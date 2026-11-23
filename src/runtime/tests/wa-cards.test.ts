import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waCards } from '../wa-cards.ts'

test('each open card gets its own 4-digit code, an answer finds its card once, and an old code is forgotten', () => {
  let n = 0
  const cards = waCards({ random: () => [0.4821, 0.4821, 0.1234][n++]!, now: () => 0 })
  const a = cards.open('card-a'), b = cards.open('card-b')
  assert.equal(a, '4821')
  assert.equal(b, '1234', 'a code still open is never handed out twice')
  assert.equal(cards.take('4821'), 'card-a')
  assert.equal(cards.take('4821'), undefined, 'a code answers one card, once')
  assert.equal(cards.take('9999'), undefined)
})
test('a code expires after a day', () => {
  let t = 0
  const cards = waCards({ random: () => 0.5, now: () => t })
  cards.open('card-a')
  t = 24 * 3600_000 + 1
  assert.equal(cards.take('5000'), undefined)
})
