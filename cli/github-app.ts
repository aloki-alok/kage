import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { appManifest } from '../core/github.ts'

type App = { id: number; slug: string; key: string; secret: string; owner: string; url: string }
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function createApp(o: { login: string; hook: string; org?: string; open: (url: string) => void; fetch?: typeof fetch; waitMs?: number }): Promise<App> {
  const state = randomBytes(16).toString('hex')
  const fetchFn = o.fetch ?? fetch
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const back = `http://127.0.0.1:${(server.address() as AddressInfo).port}/done`
      if (url.pathname === '/') {
        const action = `https://github.com/${o.org ? `organizations/${encodeURIComponent(o.org)}/` : ''}settings/apps/new?state=${state}`
        const manifest = JSON.stringify(appManifest({ login: o.login, hook: o.hook, back }))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Create Kage on GitHub</title><form id="f" method="post" action="${attr(action)}"><input type="hidden" name="manifest" value="${attr(manifest)}"><button>Create the Kage app on GitHub</button></form><script>document.getElementById('f').submit()</script>`)
        return
      }
      const code = url.searchParams.get('code')
      if (url.pathname !== '/done' || !code || url.searchParams.get('state') !== state) { res.writeHead(400).end('This link is not the one Kage opened.'); return }
      void fetchFn(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } })
        .then(async r => {
          if (!r.ok) throw new Error(`GitHub refused to hand over the new app (${r.status}). Run kage connect github again.`)
          const a = await r.json() as { id: number; slug: string; pem: string; webhook_secret: string; owner?: { login?: string }; html_url: string }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Kage on GitHub</title><p>Kage saved the app. Install it on the next page, then close this tab.</p>')
          finish(undefined, { id: a.id, slug: a.slug, key: a.pem, secret: a.webhook_secret, owner: a.owner?.login ?? o.login, url: a.html_url })
        })
        .catch(e => { res.writeHead(502).end(); finish(e as Error) })
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
