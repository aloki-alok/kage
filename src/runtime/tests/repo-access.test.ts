import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canPushToKage } from '../repo-access.ts'

test('only push access to the Kage repo marks the repo owner\'s hub', async () => {
  assert.equal(await canPushToKage(async () => 'true\n'), true)
  assert.equal(await canPushToKage(async () => 'false\n'), false)
  assert.equal(await canPushToKage(async () => { throw new Error('gh missing') }), false)
})
