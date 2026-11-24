import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createApp, nameCheck } from '../github-app.ts'
import { donePage, failPage, namePage } from '../github-page.ts'

const made = { id: 123456, slug: 'hey-kage', pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n', webhook_secret: 'whsec', owner: { login: 'ryu-dev', id: 9 }, html_url: 'https://github.com/apps/hey-kage' }

const asHost = (url: string, host: string) => new Promise<number>((done, fail) => {
  const u = new URL(url)
  request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, r => { r.resume(); done(r.statusCode!) }).on('error', fail).end()
})
const unhtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function github(o: { badStateFirst?: boolean; owner?: string; twice?: number[]; rebound?: number[]; refuse?: boolean; name?: string } = {}) {
  const traded: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    traded.push(`${init.method} ${url}`)
    if (o.twice) await new Promise(r => setTimeout(r, 30))
    if (o.refuse) return new Response('{}', { status: 422 })
    return new Response(JSON.stringify({ ...made, owner: { login: o.owner ?? 'ryu-dev', id: 9 } }), { status: 201 })
  }
  const seen = { first: '', page: '', action: '', done: '', doneStatus: 0, manifest: {} as Record<string, unknown> }
  const open = async (start: string) => {
    if (o.rebound) o.rebound.push(await asHost(start, 'evil.example:80'))
    seen.first = await (await globalThis.fetch(start)).text()
    seen.page = await (await globalThis.fetch(new URL(`/go?name=${encodeURIComponent(o.name ?? '@Hey-Kage')}`, start))).text()
    seen.action = unhtml(/action="([^"]+)"/.exec(seen.page)![1]!)
    seen.manifest = JSON.parse(unhtml(/name="manifest" value="([^"]*)"/.exec(seen.page)![1]!))
    const back = new URL(seen.manifest.redirect_url as string)
    const state = new URL(seen.action).searchParams.get('state')!
    if (o.badStateFirst) assert.equal((await globalThis.fetch(`${back}?code=forged&state=wrong`)).status, 400)
    if (o.rebound) o.rebound.push(await asHost(`${back}?code=one-time&state=${state}`, 'evil.example:80'))
    const done = `${back}?code=one-time&state=${state}`
    if (o.twice) o.twice.push(...(await Promise.all([globalThis.fetch(done), globalThis.fetch(done)])).map(r => r.status).sort())
    else { const r = await globalThis.fetch(done); seen.doneStatus = r.status; seen.done = await r.text() }
  }
  return { fetch: fetch as typeof globalThis.fetch, open: (u: string) => void open(u), traded, seen }
}

test('the owner names the app, clicks Create on GitHub, and Kage trades the one-time code for the app, its key and its webhook secret', async () => {
  const gh = github()
  const app = await createApp({ login: 'Ryu-Dev', hook: 'https://box.tail1.ts.net:8443/github', open: gh.open, fetch: gh.fetch })
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(app, { id: 123456, slug: 'hey-kage', key: made.pem, secret: 'whsec', ownerId: 9, url: made.html_url })
  assert.deepEqual(gh.traded, ['POST https://api.github.com/app-manifests/one-time/conversions'])
  assert.match(gh.seen.first, /value="kage-ryu-dev"/)
  assert.equal(gh.seen.manifest.name, 'hey-kage')
  assert.equal((gh.seen.manifest.hook_attributes as { url: string }).url, 'https://box.tail1.ts.net:8443/github')
  assert.match(gh.seen.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{32}$/)
  assert.equal(gh.seen.doneStatus, 200)
  assert.match(gh.seen.done, /href="https:\/\/github\.com\/apps\/hey-kage\/installations\/new"/)
})

test('an app for an org is made on the org\'s page', async () => {
  const gh = github({ owner: 'Acme' })
  await createApp({ login: 'ryu-dev', org: 'acme', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  assert.match(gh.seen.action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/)
})

test('a name GitHub cannot take is sent back to the name page, and the page carries no way to GitHub', async () => {
  const gh = github()
  let page = '', status = 0
  const app = createApp({ login: 'ryu-dev', hook: 'https://h/github', fetch: gh.fetch, waitMs: 200, open: u => void (async () => {
    const r = await globalThis.fetch(new URL('/go?name=hey%20kage', u)); status = r.status; page = await r.text()
  })() })
  await assert.rejects(app)
  assert.equal(status, 400)
  assert.match(page, /single hyphens/)
  assert.doesNotMatch(page, /settings\/apps\/new|state=/)
})

test('a callback with the wrong state is refused and trades nothing, and the real one still goes through', async () => {
  const gh = github({ badStateFirst: true })
  const app = await createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch })
  assert.equal(app.id, 123456)
  assert.deepEqual(gh.traded, ['POST https://api.github.com/app-manifests/one-time/conversions'])
})

test('no click within the wait ends with an error that says what to do', async () => {
  await assert.rejects(createApp({ login: 'ryu-dev', hook: 'https://h/github', open: () => {}, fetch: github().fetch, waitMs: 50 }), /Run kage connector on github again/)
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

test('when GitHub refuses the code, the tab says why in place of a blank page', async () => {
  const gh = github({ refuse: true })
  await assert.rejects(createApp({ login: 'ryu-dev', hook: 'https://h/github', open: gh.open, fetch: gh.fetch }), /422/)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(gh.seen.doneStatus, 502)
  assert.match(gh.seen.done, /GitHub refused to hand over the new app \(422\)/)
})

test('a name is free only when it is neither an app nor someone\'s account, a bad name asks GitHub nothing, and a failed look lets GitHub decide', async () => {
  const asked: string[] = []
  const lookup = (apps: string[], people: string[], down = false) => (async (url: string) => {
    asked.push(url)
    if (down) throw new Error('offline')
    const name = url.split('/').pop()!
    return new Response(null, { status: (url.includes('/apps/') ? apps : people).includes(name) ? 200 : 404 })
  }) as typeof fetch
  assert.deepEqual(await nameCheck('@Hey-Kage', lookup([], [])), { ok: true, say: '@hey-kage is free.' })
  assert.equal((await nameCheck('kagehq', lookup(['kagehq'], ['kagehq']))).say, '@kagehq is another GitHub app already. Pick another name.')
  assert.deepEqual(await nameCheck('kage', lookup([], ['kage'])), { ok: false, say: '@kage is someone\'s GitHub account, so a tag would ping them. Pick another name.' })
  assert.equal((await nameCheck('kage-x', lookup([], [], true))).ok, true)
  asked.length = 0
  assert.equal((await nameCheck('hey kage', lookup([], []))).ok, false)
  assert.deepEqual(asked, [])
})

test('what GitHub or the owner sends is shown as text on every page, never run as markup', () => {
  const evil = '"><script>alert(1)</script>'
  const pages = [
    donePage({ slug: `x${evil}`, url: `https://github.com/apps/x${evil}`, hook: `https://h${evil}`, account: `a${evil}` }),
    namePage({ name: `n${evil}`, account: `a${evil}`, problem: `p${evil}` }),
    failPage({ title: `t${evil}`, why: `w${evil}` }),
  ]
  for (const page of pages) {
    assert.doesNotMatch(page, /<script>alert/)
    assert.doesNotMatch(page, /"><script/)
    assert.match(page, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  }
})
