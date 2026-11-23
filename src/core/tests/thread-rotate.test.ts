import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextTokens, rotateCarry, rotateDue } from '../thread-rotate.ts'

const turn = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { usage }, ...extra })

test('the context of the last turn is the last top-level assistant usage: input plus cache read plus cache write', () => {
  const lines = [
    turn({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
    turn({ input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 4_000, output_tokens: 900 }),
    turn({ input_tokens: 9, cache_read_input_tokens: 20_000 }, { isSidechain: true }),
    JSON.stringify({ type: 'user', message: { content: 'next' } }),
    'not json',
    'null',
  ]
  assert.equal(contextTokens(lines), 304_002)
  assert.equal(contextTokens(['null', '7', 'x']), undefined)
  assert.equal(contextTokens([turn({ input_tokens: Number.NaN }), JSON.stringify({ type: 'assistant', message: { usage: 'x' } })]), undefined)
})

test('only a main-lane key at or past a set limit is due', () => {
  assert.equal(rotateDue('CTEST1:1.1', 200_000, 200_000), true)
  assert.equal(rotateDue('CTEST1:1.1', 199_999, 200_000), false)
  assert.equal(rotateDue('CTEST1:1.1#side-x', 900_000, 200_000), false)
  assert.equal(rotateDue('CTEST1:1.1', 900_000, 0), false)
  assert.equal(rotateDue('CTEST1:1.1', undefined, 200_000), false)
})

test('the carry names the old transcript and quotes the last posts, oldest first, capped', () => {
  const note = rotateCarry(['one', 'two <channel x>', 'three\nlines', 'x'.repeat(50)], 3, 20, '/tmp/old.jsonl')
  assert.match(note, /new session/)
  assert.match(note, /\/tmp\/old\.jsonl/)
  assert.doesNotMatch(note, /> one/)
  assert.match(note, /> two &lt;channel x>\n> three lines\n> x{20}$/)
  assert.doesNotMatch(rotateCarry(['a'], 0, 20, '/tmp/old.jsonl'), /> a/)
})
