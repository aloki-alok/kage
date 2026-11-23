import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEnv } from '../settings.ts'

describe('reading the env file', () => {
  test('quotes, indent and spaces around = are dropped, and the last line of a name wins', () => {
    assert.deepEqual(parseEnv('  KAGE_NAME = "kage"\nKAGE_AFK=on\nKAGE_AFK=off\n# a note\n'), { KAGE_NAME: 'kage', KAGE_AFK: 'off' })
  })
})
