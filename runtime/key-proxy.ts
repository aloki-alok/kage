// The key proxy (#182). Keys named in config.json `sessionKeys` never reach a session's environment: hold() takes them out of the hub's
// env at start, and this unix socket adds each one to requests for its one host. A session sends `/<token>/<host>/<path>` (curl --unix-socket)
// and the hub fetches https://<host>/<path> with the key in the route's header. Same token and trust rules as the SSM relay (runtime/ssm-relay.ts).
// The log holds host, method and status, never a path, a header or a key.
import { randomBytes } from 'node:crypto'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { ssmEligible } from '../core/ssm.ts'
import type { KeyRoute } from '../core/config.ts'

export const held = new Map<string, string>()   // key name -> value, in memory only
export function hold(names: string[]) {
  for (const n of names) { const v = process.env[n]; if (v !== undefined) held.set(n, v); delete process.env[n] }
}

// Hop-by-hop and length headers are the client's own: fetch sets them for the new request, and it already decoded the answer's body.
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade'])
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export function keyProxy(o: {
  path: string; routes: Record<string, KeyRoute>; values?: Map<string, string>; trusted: (key: string) => boolean
  log: (...a: unknown[]) => void; fetch?: (url: string, init: RequestInit & { duplex?: 'half' }) => Promise<Response>
}) {
  const values = o.values ?? held
  const send = o.fetch ?? fetch
  const tokens = new Map<string, string>()   // token -> session key
  const keyOf = new Map<string, string>()    // session key -> token
  const server = createServer(async (req, res) => {
    const refuse = (code: number, why: string) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(`kage keys: ${why}\n`) }
    const m = /^\/([0-9a-f]+)\/([^/?]+)(\/.*)?$/.exec(req.url ?? '')
    const key = m && tokens.get(m[1]!)
    if (!m || !key || !o.trusted(key)) return refuse(403, 'no key access for this session')
    const host = m[2]!.toLowerCase()
    const name = Object.keys(o.routes).find(n => o.routes[n]!.host === host)
    const value = name && values.get(name)
    if (!name || !value) return refuse(403, `no key is set for ${host}`)
    const route = o.routes[name]!
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQ.has(k) && k !== (route.header ?? 'authorization').toLowerCase()) headers.set(k, [v].flat().join(', '))
    headers.set(route.header ?? 'authorization', `${route.prefix ?? 'Bearer '}${value}`)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as unknown as BodyInit)
    try {
      const r = await send(`https://${host}${m[3] ?? '/'}`, { method: req.method, headers, body, redirect: 'manual', duplex: 'half' })   // manual: a redirect never carries the key elsewhere
      o.log('key proxy', host, req.method, r.status, 'for', key)
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !DROP_RES.has(k))))
      if (r.body) Readable.fromWeb(r.body as never).on('error', () => res.destroy()).pipe(res); else res.end()
    } catch (e) {
      o.log('key proxy', host, req.method, 'failed', (e as Error).name, 'for', key)
      refuse(502, 'the request failed')
    }
  })
  try { unlinkSync(o.path) } catch {}
  const mask = process.umask(0o177)   // the socket is born 600, with no window before the chmod
  server.listen(o.path)
  process.umask(mask)
  chmodSync(o.path, 0o600)
  return {
    // A token for an owner-only Slack thread, else undefined. One token per session key: a new start replaces the old one.
    issue(key: string) {
      if (!ssmEligible(key) || !o.trusted(key)) return
      this.drop(key)
      const t = randomBytes(24).toString('hex')
      tokens.set(t, key); keyOf.set(key, t)
      return t
    },
    drop(key: string) { const t = keyOf.get(key); if (t) tokens.delete(t); keyOf.delete(key) },
    close() { server.close(); try { unlinkSync(o.path) } catch {} },
  }
}
