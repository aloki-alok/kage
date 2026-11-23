import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEARD, heardLine } from '../heard.ts'

test('one or two words from the model are posted with the ninja', async () => {
  assert.equal(await heardLine('drop my ask', async () => 'Dropped.\nextra'), 'Dropped. :ninja:')
  assert.equal(await heardLine('thanks', async () => 'Anytime'), 'Anytime :ninja:')
})
test('a failed, empty, tagging, linking, longer or secret-bearing answer falls back to Noted', async () => {
  const bad = [async () => { throw new Error('down') }, async () => '', async () => 'ok <@UTEST1>', async () => 'see https://example.test',
    async () => 'three whole words', async () => 'here xoxb-1234567890-abcdefghijkl']
  for (const write of bad) assert.equal(await heardLine('post', write), HEARD)
})
