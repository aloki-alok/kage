import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { appInstallations, appJwt } from '../github-app.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split('.')[i]!, 'base64url').toString())

test('the app token is an RS256 JWT signed with the app key, issued by the app, back-dated a minute and good for under ten minutes', () => {
  const now = Date.UTC(2026, 10, 22, 12)
  const jwt = appJwt(123456, privateKey, now)
  const [head, body, sig] = jwt.split('.')
  assert.equal(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, 'base64url')), true)
  assert.deepEqual(part(jwt, 0), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(part(jwt, 1), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123456' })
})

test('the installations are read with the app token, page by page', async () => {
  const asked: { url: string; auth: string }[] = []
  const pages: Record<string, { body: object[]; next?: string }> = {
    'https://api.github.com/app/installations?per_page=100': { body: [{ id: 41, account: { login: 'ryu-dev' } }], next: 'https://api.github.com/app/installations?per_page=100&page=2' },
    'https://api.github.com/app/installations?per_page=100&page=2': { body: [{ id: 42, account: { login: 'acme' } }] },
  }
  const fetch = async (url: string, init: RequestInit) => {
    asked.push({ url, auth: (init.headers as Record<string, string>).Authorization! })
    const p = pages[url]!
    return new Response(JSON.stringify(p.body), { headers: p.next ? { link: `<${p.next}>; rel="next"` } : {} })
  }
  const list = await appInstallations({ id: 123456, key: privateKey }, fetch as typeof globalThis.fetch)
  assert.deepEqual(list.map(i => i.id), [41, 42])
  assert.equal(asked.length, 2)
  assert.match(asked[0]!.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
})

test('a refused app token is an error that names the status, never a silent empty list', async () => {
  const fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 })
  await assert.rejects(appInstallations({ id: 1, key: privateKey }, fetch as typeof globalThis.fetch), /401/)
})
