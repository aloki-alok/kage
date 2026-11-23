import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { holdKeys } from '../hold-keys.ts'

test('when key-proxy.ts cannot load, the named keys are still deleted from the environment and the owner is told', async () => {
  process.env.FAKE_LOST_KEY = 'fake-value'
  process.env.FAKE_KEPT = 'stays'
  const said: string[] = []
  await holdKeys(['FAKE_LOST_KEY'], s => said.push(s), () => Promise.reject(new Error('boom')))
  assert.equal(process.env.FAKE_LOST_KEY, undefined)
  assert.equal(process.env.FAKE_KEPT, 'stays')
  assert.equal(said.length, 1)
  assert.ok(!said[0]!.includes('fake-value'))
  delete process.env.FAKE_KEPT
})

test('hub.ts holds the keys before it loads the router', () => {
  const hub = readFileSync(new URL('../../../hub.ts', import.meta.url), 'utf8')
  const held = hub.indexOf('holdKeys(')
  assert.ok(held > 0, 'hub.ts never calls holdKeys')
  assert.ok(held < hub.indexOf("import('./src/hub/router.ts')"), 'holdKeys runs after the router loads')
})
