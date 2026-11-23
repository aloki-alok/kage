import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addScopes, authTest, checkScopes } from '../slack-scopes.ts'

const reply = (scopes: string | null, body: object = { ok: true, bot_id: 'B1', team_id: 'T1' }) => async () =>
  new Response(JSON.stringify(body), { headers: scopes === null ? {} : { 'x-oauth-scopes': scopes } })

test('authTest reads the scopes from the x-oauth-scopes header', async () => {
  assert.deepEqual(await authTest('t', reply('chat:write, users:read')), { scopes: ['chat:write', 'users:read'], botId: 'B1', teamId: 'T1' })
})
test('Slack refusing the token gives undefined, not an empty scope list', async () => {
  assert.equal(await authTest('t', reply(null, { ok: false, error: 'invalid_auth' })), undefined)
})
test('checkScopes returns what each token lacks', async () => {
  const f = async (_: any, init: any) => reply(init.headers.Authorization.endsWith('bot') ? 'chat:write' : 'mpim:write')()
  const m = await checkScopes({ user: 'u', bot: 'bot' }, { bot: ['chat:write', 'users:read'], user: ['mpim:write', 'files:read'] }, f as any)
  assert.deepEqual(m, { bot: ['users:read'], user: ['files:read'] })
})

const slackApi = (answers: Record<string, object>, seen: { url: string; body: string; auth: string }[] = []) => (async (url: string, init: any) => {
  seen.push({ url, body: String(init.body), auth: init.headers.Authorization })
  return new Response(JSON.stringify(answers[url.split('/').pop()!] ?? { ok: false, error: 'unknown_method' }))
}) as any

test('addScopes exports the manifest, adds the missing scopes and saves it whole', async () => {
  const seen: { url: string; body: string; auth: string }[] = []
  const manifest = { display_information: { name: 'K' }, oauth_config: { scopes: { user: ['a'], bot: ['b'] } } }
  const r = await addScopes('cfg', 'A1', { bot: [], user: ['c'] }, slackApi({ 'apps.manifest.export': { ok: true, manifest }, 'apps.manifest.update': { ok: true } }, seen))
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(seen.map(s => s.url.split('/').pop()), ['apps.manifest.export', 'apps.manifest.update'])
  assert.ok(seen.every(s => s.auth === 'Bearer cfg'))
  const sent = new URLSearchParams(seen[1]!.body)
  assert.equal(sent.get('app_id'), 'A1')
  assert.deepEqual(JSON.parse(sent.get('manifest')!), { display_information: { name: 'K' }, oauth_config: { scopes: { user: ['a', 'c'], bot: ['b'] } } })
})
test('addScopes saves nothing when the export fails or has the wrong shape', async () => {
  const seen: { url: string; body: string; auth: string }[] = []
  assert.deepEqual(await addScopes('cfg', 'A1', { bot: [], user: ['c'] }, slackApi({ 'apps.manifest.export': { ok: false, error: 'invalid_auth' } }, seen)), { ok: false, error: 'invalid_auth' })
  assert.deepEqual(await addScopes('cfg', 'A1', { bot: [], user: ['c'] }, slackApi({ 'apps.manifest.export': { ok: true, manifest: null } }, seen)), { ok: false, error: 'unreadable_manifest' })
  assert.ok(seen.every(s => !s.url.endsWith('update')))
})
test('addScopes passes on why Slack refused the update', async () => {
  const r = await addScopes('cfg', 'A1', { bot: [], user: ['c'] }, slackApi({ 'apps.manifest.export': { ok: true, manifest: { oauth_config: { scopes: {} } } }, 'apps.manifest.update': { ok: false, error: 'invalid_manifest' } }))
  assert.deepEqual(r, { ok: false, error: 'invalid_manifest' })
})
test('a network failure is an error, not a throw', async () => {
  assert.deepEqual(await addScopes('cfg', 'A1', { bot: [], user: ['c'] }, (async () => { throw new Error('down') }) as any), { ok: false, error: 'network' })
})
