import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_SCOPES, USER_SCOPES, missingScopes, scopeLines, scopeDm, manifestUrl, upgradeSteps } from '../slack-scopes.ts'

describe('missingScopes', () => {
  test('lists wanted scopes the app lacks, in wanted order', () => {
    assert.deepEqual(missingScopes(['a', 'b', 'c'], ['c', 'a']), ['b'])
  })
  test('nothing is missing when granted holds every wanted scope, extras allowed', () => {
    assert.deepEqual(missingScopes(['a', 'b'], ['b', 'a', 'z']), [])
  })
})

test('the manifest lists include the scopes Kage calls need', () => {
  assert.ok(USER_SCOPES.includes('files:read'))
  assert.ok(USER_SCOPES.includes('search:read'), 'the voice search tool calls the user Slack search API')
  assert.ok(USER_SCOPES.includes('users:read.email'), 'kage add <email> calls users.lookupByEmail with the user token')
  assert.ok(!BOT_SCOPES.includes('search:read'))
  assert.ok(BOT_SCOPES.includes('chat:write'))
  for (const s of ['reactions:read', 'pins:read', 'bookmarks:read', 'usergroups:read', 'team:read', 'dnd:read', 'canvases:read', 'lists:read'])
    assert.ok(USER_SCOPES.includes(s), `a new install reads ${s} by default`)
  assert.ok(BOT_SCOPES.includes('reactions:read'), 'the bot reads reactions on its own posts')
})

describe('doctor lines', () => {
  test('complete app: one ok line', () => {
    assert.deepEqual(scopeLines({ bot: [], user: [] }), [{ kind: 'ok', text: 'the Slack app has every scope' }])
  })
  test('missing scopes: one FAIL line per kind, naming the fix', () => {
    assert.deepEqual(scopeLines({ bot: [], user: ['mpim:write', 'files:read'] }), [
      { kind: 'fail', text: 'the Slack app lacks user scopes mpim:write, files:read: run kage slack upgrade' },
    ])
    assert.equal(scopeLines({ bot: ['x'], user: ['y'] }).length, 2)
  })
})

describe('scopeDm: once per distinct missing set', () => {
  const m = { bot: [], user: ['mpim:write'] }
  test('nothing missing: no DM, and the stored set clears', () => {
    assert.deepEqual(scopeDm({ bot: [], user: [] }, 'user:mpim:write'), { send: undefined, told: undefined })
  })
  test('a new set: DM that lists the scopes and the command', () => {
    const d = scopeDm(m, undefined)
    assert.match(d.send!, /mpim:write/)
    assert.match(d.send!, /kage slack upgrade/)
    assert.equal(d.told, 'user:mpim:write')
  })
  test('the same set again: no DM', () => {
    assert.equal(scopeDm(m, 'user:mpim:write').send, undefined)
  })
  test('a different set: DM again', () => {
    assert.ok(scopeDm({ bot: [], user: ['mpim:write', 'files:read'] }, 'user:mpim:write').send)
  })
})

describe('kage slack upgrade steps', () => {
  test('the page is the app manifest of this team and app', () => {
    assert.equal(manifestUrl('T1', 'A1'), 'https://app.slack.com/app-settings/T1/A1/app-manifest')
  })
  test('names each missing scope under its list, never asks for a whole manifest, then reinstall', () => {
    const t = upgradeSteps({ bot: ['files:write'], user: ['files:read', 'mpim:write'] }, 'https://x.test/m').join('\n')
    assert.match(t, /oauth_config\.scopes\.user.*files:read, mpim:write/)
    assert.match(t, /oauth_config\.scopes\.bot.*files:write/)
    assert.match(t, /Save Changes/)
    assert.match(t, /Reinstall to Workspace/)
    assert.match(t, /Do not paste a whole manifest/)
    assert.doesNotMatch(t, /bot.*files:read|user.*files:write/)
  })
  test('a kind with nothing missing gets no line', () => {
    assert.doesNotMatch(upgradeSteps({ bot: [], user: ['files:read'] }, 'u').join('\n'), /scopes\.bot/)
  })
})
