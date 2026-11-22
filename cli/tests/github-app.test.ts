import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createApp } from '../github-app.ts'

const made = { id: 123456, slug: 'kage-ryu-dev', pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n', webhook_secret: 'whsec', owner: { login: 'ryu-dev', id: 9 }, html_url: 'https://github.com/apps/kage-ryu-dev' }

const asHost = (url: string, host: string) => new Promise<number>((done, fail) => {
  const u = new URL(url)
  request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, r => { r.resume(); done(r.statusCode!) }).on('error', fail).end()
})

function github(o: { badStateFirst?: boolean; owner?: string; twice?: number[]; rebound?: number[] } = {}) {
  const traded: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    traded.push(`${init.method} ${url}`)
    if (o.twice) await new Promise(r => setTimeout(r, 30))
    return new Response(JSON.stringify({ ...made, owner: { login: o.owner ?? 'ryu-dev', id: 9 } }), { status: 201 })
  }
  let page = '', action = ''
  const open = async (start: string) => {
    if (o.rebound) o.rebound.push(await asHost(start, 'evil.example:80'))
    page = await (await globalThis.fetch(start)).text()
    action = /action="([^"]+)"/.exec(page)![1]!
    const manifest = JSON.parse(/name="manifest" value="([^"]*)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    const back = new URL(manifest.redirect_url)
    const state = new URL(action.replace(/&amp;/g, '&')).searchParams.get('state')!
    if (o.badStateFirst) assert.equal((await globalThis.fetch(`${back}?code=forged&state=wrong`)).status, 400)
    if (o.rebound) o.rebound.push(await asHost(`${back}?code=one-time&state=${state}`, 'evil.example:80'))
    const done = `${back}?code=one-time&state=${state}`
    if (o.twice) o.twice.push(...(await Promise.all([globalThis.fetch(done), globalThis.fetch(done)])).map(r => r.status).sort())
    else await globalThis.fetch(done)
  }
  return { fetch: fetch as typeof globalThis.fetch, open: (u: string) => void open(u), traded, seen: () => ({ page, action }) }
}

test('the owner clicks Create on GitHub, and Kage trades the one-time code for the app, its key and its webhook secret', async () => {
  const gh = github()
  const app = await createApp({ login: 'ryu-dev', hook: 'https://box.tail1.ts.net:8443/github', open: gh.open, fetch: gh.fetch })
  assert.deepEqual(app, { id: 123456, slug: 'kage-ryu-dev', key: made.pem, secret: 'whsec', ownerId: 9, url: made.html_url })
  assert.deepEqual(gh.traded, ['POST https://api.github.com/app-manifests/one-time/conversions'])
  assert.match(gh.seen().action, /^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{32}$/)
  assert.match(gh.seen().page, /https:\/\/box\.tail1\.ts\.net:8443\/github/)
})

test('an app for an org is made on the org\'s page', async () => {
  const gh = github({ owner: 'Acme' })
  await createApp({ login: 'ryu-dev', org: 'acme', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  assert.match(gh.seen().action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/)
})

test('a callback with the wrong state is refused and trades nothing, and the real one still goes through', async () => {
  const gh = github({ badStateFirst: true })
  const app = await createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  assert.equal(app.id, 123456)
  assert.deepEqual(gh.traded, ['POST https://api.github.com/app-manifests/one-time/conversions'])
})

test('no click within the wait ends with an error that says what to do', async () => {
  await assert.rejects(createApp({ login: 'ryu-dev', hook: 'https://h/github', open: () => {}, fetch: github().fetch, waitMs: 50 }), /Run kage connect github again/)
})

test('the one-time code is traded once, so a second click while the first is in flight cannot throw the new app away', async () => {
  const twice: number[] = []
  const gh = github({ twice })
  const app = await createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(app.id, 123456)
  assert.equal(gh.traded.length, 1)
  assert.deepEqual(twice, [200, 409])
})

test('a page from another site that reaches the local server by a renamed address is refused, and learns nothing', async () => {
  const rebound: number[] = []
  const gh = github({ rebound })
  await createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  assert.deepEqual(rebound, [421, 421])
  assert.equal(gh.traded.length, 1)
})

test('an app GitHub made on some other account is refused, so nobody else\'s app can sign events for this Kage', async () => {
  const gh = github({ owner: 'mallory' })
  await assert.rejects(createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch }), /made the app on mallory, not ryu-dev/)
})
