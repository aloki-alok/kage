import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEARD, heardLine } from '../slack-heard.ts'

test('a fresh line from the model is posted as written', async () => {
  assert.equal(await heardLine('done, no reply needed', '5.5', async () => 'Shadows noted, blade stays home.\nextra'), 'Shadows noted, blade stays home.')
})
test('a failed, empty, tagging, linking, long or secret-bearing line falls back to a fixed one', async () => {
  const bad = [async () => { throw new Error('down') }, async () => '', async () => 'ok <@UTEST1>', async () => 'see https://example.test',
    async () => 'x'.repeat(161), async () => 'here xoxb-1234567890-abcdefghijkl']
  for (const write of bad) assert.ok(HEARD.includes(await heardLine('post', '5.5', write)))
})
