import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_SCOPES, USER_SCOPES, missingScopes, scopeLines, scopeDm } from '../slack-scopes.ts'

describe('missingScopes', () => {
  test('lists wanted scopes the app lacks, in wanted order', () => {
    assert.deepEqual(missingScopes(['a', 'b', 'c'], ['c', 'a']), ['b'])
  })
  test('nothing is missing when granted holds every wanted scope, extras allowed', () => {
    assert.deepEqual(missingScopes(['a', 'b'], ['b', 'a', 'z']), [])
  })
})

test('the manifest lists include the 2026-11-13 additions', () => {
  assert.ok(USER_SCOPES.includes('files:read') && USER_SCOPES.includes('search:read'))
  assert.ok(BOT_SCOPES.includes('chat:write'))
})

describe('doctor lines', () => {
  test('complete app: one ok line', () => {
    assert.deepEqual(scopeLines({ bot: [], user: [] }), [{ ok: true, text: 'the Slack app has every scope' }])
  })
  test('missing scopes: one FAIL line per kind, naming the fix', () => {
    assert.deepEqual(scopeLines({ bot: [], user: ['search:read', 'files:read'] }), [
      { ok: false, text: 'the Slack app lacks user scopes search:read, files:read: run kage slack upgrade' },
    ])
    assert.equal(scopeLines({ bot: ['x'], user: ['y'] }).length, 2)
  })
})

describe('scopeDm: once per distinct missing set', () => {
  const m = { bot: [], user: ['search:read'] }
  test('nothing missing: no DM, and the stored set clears', () => {
    assert.deepEqual(scopeDm({ bot: [], user: [] }, 'user:search:read'), { send: undefined, told: undefined })
  })
  test('a new set: DM that lists the scopes and the command', () => {
    const d = scopeDm(m, undefined)
    assert.match(d.send!, /search:read/)
    assert.match(d.send!, /kage slack upgrade/)
    assert.equal(d.told, 'user:search:read')
  })
  test('the same set again: no DM', () => {
    assert.equal(scopeDm(m, 'user:search:read').send, undefined)
  })
  test('a different set: DM again', () => {
    assert.ok(scopeDm({ bot: [], user: ['search:read', 'files:read'] }, 'user:search:read').send)
  })
})
