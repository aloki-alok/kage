import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { appManifest } from '../core/github.ts'

type App = { id: number; slug: string; key: string; secret: string; ownerId: number; url: string }
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
      const back = `http://${here}/done`
      if (url.pathname === '/') {
        const action = `https://github.com/${o.org ? `organizations/${encodeURIComponent(o.org)}/` : ''}settings/apps/new?state=${state}`
        const manifest = JSON.stringify(appManifest({ login: o.login, hook: o.hook, back }))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Create Kage on GitHub</title><form id="f" method="post" action="${attr(action)}"><input type="hidden" name="manifest" value="${attr(manifest)}"><button>Create the Kage app on GitHub</button></form><script>document.getElementById('f').submit()</script>`)
        return
      }
      const code = url.searchParams.get('code')
      if (url.pathname !== '/done' || !code || url.searchParams.get('state') !== state) { res.writeHead(400).end('This link is not the one Kage opened.'); return }
      if (taken) { res.writeHead(409).end('Kage already took this app.'); return }
      taken = true
      void fetchFn(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } })
        .then(async r => {
          if (!r.ok) throw new Error(`GitHub refused to hand over the new app (${r.status}). Run kage connect github again.`)
          const a = await r.json() as { id: number; slug: string; pem: string; webhook_secret: string; owner?: { login?: string; id?: number }; html_url: string }
          if (a.owner?.login?.toLowerCase() !== account.toLowerCase() || !a.owner.id) throw new Error(`GitHub made the app on ${a.owner?.login ?? 'no account'}, not ${account}. Delete it at ${a.html_url}, then run kage connect github again.`)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Kage on GitHub</title><p>Kage saved the app. Install it on the next page, then close this tab.</p>')
          finish(undefined, { id: a.id, slug: a.slug, key: a.pem, secret: a.webhook_secret, ownerId: a.owner.id, url: a.html_url })
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
