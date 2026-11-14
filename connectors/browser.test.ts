import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectBrowser } from './browser.ts'

const TOKEN = 'test-token'
const auth = { authorization: `Bearer ${TOKEN}` }

async function hub(o: Partial<Parameters<typeof connectBrowser>[0]> = {}) {
  const b = connectBrowser({ token: TOKEN, port: 0, ...o })
  const port = await b.listening
  const url = `http://127.0.0.1:${port}`
  const next = (headers: Record<string, string> = auth) => fetch(`${url}/browser/next`, { headers })
  const result = (body: unknown) => fetch(`${url}/browser/result`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  return { b, url, next, result }
}

test('a call reaches the extension on its next poll, and its result comes back to the caller', async t => {
  const { b, next, result } = await hub()
  t.after(() => b.close())
  const poll = next()
  while (!b.connected()) await new Promise(r => setTimeout(r, 5))
  const answer = b.call('read', { tabId: 7 })
  const cmd = await (await poll).json() as { id: string; op: string; args: unknown }
  assert.equal(cmd.op, 'read')
  assert.deepEqual(cmd.args, { tabId: 7 })
  assert.equal((await result({ id: cmd.id, ok: true, data: { title: 'T' } })).status, 200)
  assert.deepEqual(await answer, { title: 'T' })
})

test('a call made before the poll waits for it', async t => {
  const { b, next, result } = await hub({ pollMs: 30 })
  t.after(() => b.close())
  await (await next()).body?.cancel().catch(() => {})   // the extension has polled once, so it counts as connected
  const refused = assert.rejects(b.call('tabs', {}), /no such tab/)
  const cmd = await (await next()).json() as { id: string }
  await result({ id: cmd.id, ok: false, error: 'no such tab' })
  await refused
})

test('a call with no extension connected fails at once and says how to connect it', async t => {
  const { b } = await hub()
  t.after(() => b.close())
  await assert.rejects(b.call('tabs', {}), /extension is not connected/)
})

test('a call the extension never answers times out', async t => {
  const { b, next } = await hub({ callMs: 50, pollMs: 30 })
  t.after(() => b.close())
  await (await next()).body?.cancel().catch(() => {})
  await assert.rejects(b.call('tabs', {}), /did not answer/)
})

test('an empty poll ends with 204 after its wait', async t => {
  const { b, next } = await hub({ pollMs: 30 })
  t.after(() => b.close())
  assert.equal((await next()).status, 204)
})

test('refuses without the token, and on any other path', async t => {
  const { b, url, next } = await hub()
  t.after(() => b.close())
  assert.equal((await next({ authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await fetch(`${url}/browser/next`, { method: 'OPTIONS' })).status, 401)   // no CORS door for a web page
  assert.equal((await fetch(`${url}/other`, { headers: auth })).status, 404)
})

test('a command whose poll died before the extension read it goes out again on the next poll', async t => {
  const { b, url, next, result } = await hub({ pollMs: 5000 })
  t.after(() => b.close())
  const ac = new AbortController()
  void fetch(`${url}/browser/next`, { headers: auth, signal: ac.signal }).catch(() => {})
  while (!b.connected()) await new Promise(r => setTimeout(r, 5))
  ac.abort()
  const answer = b.call('tabs', {})   // may be written to the dying socket
  await new Promise(r => setTimeout(r, 50))
  const cmd = await (await next()).json() as { id: string; op: string }
  assert.equal(cmd.op, 'tabs')
  await result({ id: cmd.id, ok: true, data: [] })
  assert.deepEqual(await answer, [])
})
