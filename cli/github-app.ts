import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { appManifest, appName } from '../core/github.ts'
import { donePage, failPage, goPage, namePage } from './github-page.ts'

type App = { id: number; slug: string; key: string; secret: string; ownerId: number; url: string }
const FONT = new URL('../docs/brand/fonts/GeistPixel-Square.woff2', import.meta.url)
const html = (res: ServerResponse, status: number, body: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body)

export async function nameCheck(typed: string, fetchFn: typeof fetch): Promise<{ ok: boolean; say: string }> {
  const n = appName(typed)
  if ('problem' in n) return { ok: false, say: n.problem }
  const look = (url: string) => fetchFn(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'kage-setup' } }).then(r => r.status, () => 0)
  const [app, person] = await Promise.all([look(`https://github.com/apps/${n.name}`), look(`https://api.github.com/users/${n.name}`)])
  if (app === 200) return { ok: false, say: `@${n.name} is another GitHub app already. Pick another name.` }
  if (person === 200) return { ok: false, say: `@${n.name} is someone's GitHub account, so a tag would ping them. Pick another name.` }
  if (app === 404 && person === 404) return { ok: true, say: `@${n.name} is free.` }
  return { ok: true, say: `Kage could not check @${n.name}. GitHub says so on the next page if it is taken.` }
}

export function createApp(o: { login: string; hook: string; org?: string; open: (url: string) => void; fetch?: typeof fetch; waitMs?: number }): Promise<App> {
  const state = randomBytes(16).toString('hex')
  const fetchFn = o.fetch ?? fetch
  const account = o.org ?? o.login
  let taken = false
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const here = `127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.headers.host !== here) { res.writeHead(421).end(); return }
      const url = new URL(req.url ?? '/', `http://${here}`)
      if (url.pathname === '/type.woff2') { void readFile(FONT).then(f => res.writeHead(200, { 'content-type': 'font/woff2' }).end(f), () => res.writeHead(404).end()); return }
      if (url.pathname === '/') { html(res, 200, namePage({ name: `kage-${o.login.toLowerCase()}`.slice(0, 34), account })); return }
      if (url.pathname === '/name') { void nameCheck(url.searchParams.get('n') ?? '', fetchFn).then(r => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r))); return }
      if (url.pathname === '/go') {
        const typed = url.searchParams.get('name') ?? '', n = appName(typed)
        if ('problem' in n) { html(res, 400, namePage({ name: typed.replace(/^@/, ''), account, problem: n.problem })); return }
        const action = `https://github.com/${o.org ? `organizations/${encodeURIComponent(o.org)}/` : ''}settings/apps/new?state=${state}`
        html(res, 200, goPage({ name: n.name, action, manifest: JSON.stringify(appManifest({ name: n.name, hook: o.hook, back: `http://${here}/done` })) }))
        return
      }
      const code = url.searchParams.get('code')
      if (url.pathname !== '/done' || !code || url.searchParams.get('state') !== state) { html(res, 400, failPage({ title: 'Not this link', why: 'This link is not the one Kage opened.' })); return }
      if (taken) { html(res, 409, failPage({ title: 'Already done', why: 'Kage already took this app. Look at the other tab.' })); return }
      taken = true
      void fetchFn(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } })
        .then(async r => {
          if (!r.ok) throw new Error(`GitHub refused to hand over the new app (${r.status}). Run kage connect github again.`)
          const a = await r.json() as { id: number; slug: string; pem: string; webhook_secret: string; owner?: { login?: string; id?: number }; html_url: string }
          if (a.owner?.login?.toLowerCase() !== account.toLowerCase() || !a.owner.id) throw new Error(`GitHub made the app on ${a.owner?.login ?? 'no account'}, not ${account}. Delete it at ${a.html_url}, then run kage connect github again.`)
          html(res, 200, donePage({ slug: a.slug, url: a.html_url, hook: o.hook, account }))
          finish(undefined, { id: a.id, slug: a.slug, key: a.pem, secret: a.webhook_secret, ownerId: a.owner.id, url: a.html_url })
        })
        .catch(e => { html(res, 502, failPage({ title: 'GitHub said no', why: (e as Error).message.replace(/ Run kage connect github again\.$/, '') })); finish(e as Error) })
    })
    const timer = setTimeout(() => finish(new Error('No app was created on GitHub in time. Run kage connect github again.')), o.waitMs ?? 600_000)
    function finish(e: Error | undefined, app?: App) {
      clearTimeout(timer)
      server.close()
      if (e) reject(e); else resolve(app!)
    }
    server.listen(0, '127.0.0.1', () => o.open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`))
  })
}
