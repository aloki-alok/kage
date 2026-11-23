import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_SCOPES, USER_SCOPES, missingScopes, scopeLines, scopeDm, manifestUrl, upgradeSteps, withScopes, pasteSteps, installUrl } from '../slack-scopes.ts'

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

describe('withScopes: Kage edits the manifest itself', () => {
  const app = { display_information: { name: 'K' }, oauth_config: { scopes: { user: ['search:read'], bot: ['chat:write'], user_optional: ['lists:read'] }, pkce_enabled: false }, settings: { interactivity: { is_enabled: true } } }
  test('appends each missing scope to its list and keeps every other field', () => {
    const m = withScopes(app, { bot: ['files:write'], user: ['pins:read', 'dnd:read'] })!
    assert.deepEqual(m.oauth_config.scopes, { user: ['search:read', 'pins:read', 'dnd:read'], bot: ['chat:write', 'files:write'], user_optional: ['lists:read'] })
    assert.deepEqual({ ...m, oauth_config: undefined }, { ...app, oauth_config: undefined })
    assert.equal(m.oauth_config.pkce_enabled, false)
  })
  test('never adds a scope twice, and does not change the input', () => {
    const m = withScopes(app, { bot: ['chat:write'], user: [] })!
    assert.deepEqual(m.oauth_config.scopes.bot, ['chat:write'])
    assert.deepEqual(app.oauth_config.scopes.user, ['search:read'])
  })
  test('a list the manifest lacks is created', () => {
    assert.deepEqual(withScopes({ oauth_config: { scopes: { bot: ['a'] } } }, { bot: [], user: ['b'] })!.oauth_config.scopes, { bot: ['a'], user: ['b'] })
  })
  test('a manifest of the wrong shape gives undefined, so Kage changes nothing', () => {
    for (const bad of [null, 3, 'x', [], { oauth_config: 1 }, { oauth_config: { scopes: { user: 'x' } } }, { oauth_config: { scopes: { bot: [1] } } }])
      assert.equal(withScopes(bad, { bot: [], user: ['b'] }), undefined, JSON.stringify(bad))
  })
})

describe('kage slack upgrade steps', () => {
  test('the pages are the app manifest and the install page of this app', () => {
    assert.equal(manifestUrl('T1', 'A1'), 'https://app.slack.com/app-settings/T1/A1/app-manifest')
    assert.equal(installUrl('A1'), 'https://api.slack.com/apps/A1/install-on-team')
  })
  test('after Kage saved the manifest, only the reinstall is left', () => {
    const t = upgradeSteps('https://x.test/i').join('\n')
    assert.match(t, /https:\/\/x\.test\/i/)
    assert.match(t, /Reinstall to Workspace/)
    assert.doesNotMatch(t, /manifest/i)
  })
  test('by hand: exact JSON lines to paste, under the list each belongs to', () => {
    const t = pasteSteps({ bot: ['files:write'], user: ['files:read', 'mpim:write'] }, 'https://x.test/m').join('\n')
    assert.match(t, /After "user": \[ paste:\n\s+"files:read",\n\s+"mpim:write",/)
    assert.match(t, /After "bot": \[ paste:\n\s+"files:write",/)
    assert.doesNotMatch(t, /oauth_config\.scopes/)
    assert.match(t, /If a list is \[\] or missing/)
    assert.match(t, /Save Changes/)
    assert.match(t, /Reinstall to Workspace/)
  })
  test('a kind with nothing missing gets no list', () => {
    assert.doesNotMatch(pasteSteps({ bot: [], user: ['files:read'] }, 'u').join('\n'), /"bot"/)
  })
})
