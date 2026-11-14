import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authTest, checkScopes } from '../slack-scopes.ts'

const reply = (scopes: string | null, body: object = { ok: true, bot_id: 'B1' }) => async () =>
  new Response(JSON.stringify(body), { headers: scopes === null ? {} : { 'x-oauth-scopes': scopes } })

test('authTest reads the scopes from the x-oauth-scopes header', async () => {
  assert.deepEqual(await authTest('t', reply('chat:write, users:read')), { scopes: ['chat:write', 'users:read'], botId: 'B1' })
})
test('Slack refusing the token gives undefined, not an empty scope list', async () => {
  assert.equal(await authTest('t', reply(null, { ok: false, error: 'invalid_auth' })), undefined)
})
test('checkScopes returns what each token lacks', async () => {
  const f = async (_: any, init: any) => reply(init.headers.Authorization.endsWith('bot') ? 'chat:write' : 'search:read')()
  const m = await checkScopes({ user: 'u', bot: 'bot' }, { bot: ['chat:write', 'users:read'], user: ['search:read', 'files:read'] }, f as any)
  assert.deepEqual(m, { bot: ['users:read'], user: ['files:read'] })
})
