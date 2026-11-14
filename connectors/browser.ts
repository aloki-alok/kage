// Browser connector (#114): the hub's side of Kage's Chrome extension. The extension long-polls
// 127.0.0.1:<port>/browser/next for a command, runs it in the owner's Chrome, and posts what it got to
// /browser/result. Long polling, not a socket: plain node:http on this side, plain fetch in the extension.
// Both paths need `Authorization: Bearer <KAGE_BROWSER_TOKEN>`. A web page cannot send that header across
// origins without a preflight, and the preflight gets 401, so no page the owner visits can drive this.
// What a session may see of a page is core/browser.ts. Off unless KAGE_BROWSER_TOKEN is set.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_BODY = 20_000_000   // a full-page PNG screenshot as base64 fits well under this

const digest = (s: string) => createHash('sha256').update(s).digest()
const bearerOk = (header: string | undefined, token: string) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))

type Cmd = { id: string; op: string; args: unknown }

export function connectBrowser(o: {
  token: string; port: number
  pollMs?: number    // how long one poll is held open with nothing to send
  callMs?: number    // how long a call waits for the extension's answer
  staleMs?: number   // with no poll for this long, the extension counts as gone
  now?: () => number
}) {
  const now = o.now ?? Date.now
  const pollMs = o.pollMs ?? 25_000, callMs = o.callMs ?? 20_000, staleMs = o.staleMs ?? 60_000
  const queue: Cmd[] = []
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  let waiter: { res: ServerResponse; timer: NodeJS.Timeout } | undefined
  let lastPoll = -Infinity

  const release = (status: 204 | 200, body?: string) => {
    if (!waiter) return
    clearTimeout(waiter.timer)
    const { res } = waiter
    waiter = undefined
    if (status === 204) res.writeHead(204).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  }
  const flush = () => { if (waiter && queue.length) release(200, JSON.stringify(queue.shift())) }
  const connected = () => !!waiter || now() - lastPoll < staleMs

  function call(op: string, args: unknown): Promise<unknown> {
    if (!connected()) return Promise.reject(new Error('the Kage Chrome extension is not connected: install it from the extension folder and paste KAGE_BROWSER_TOKEN into its options'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        const i = queue.findIndex(c => c.id === id)
        if (i >= 0) queue.splice(i, 1)
        reject(new Error(`the Chrome extension did not answer in ${Math.round(callMs / 1000)} s`))
      }, callMs)
      pending.set(id, { resolve, reject, timer })
      queue.push({ id, op, args })
      flush()
    })
  }

  const server = createServer((req, res) => {
    if (!bearerOk(req.headers.authorization, o.token)) { res.writeHead(401).end(); return }
    if (req.method === 'GET' && req.url === '/browser/next') {
      lastPoll = now()
      release(204)   // one poll at a time: a newer one (a restarted extension) replaces the old
      waiter = { res, timer: setTimeout(() => release(204), pollMs) }
      req.on('close', () => { if (waiter?.res === res && !res.writableEnded) { clearTimeout(waiter.timer); waiter = undefined } })
      flush()
      return
    }
    if (req.method !== 'POST' || req.url !== '/browser/result') { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      let r: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown }
      try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
      const p = typeof r.id === 'string' ? pending.get(r.id) : undefined
      // A result after its call timed out has no one waiting.
      if (!p) { res.writeHead(404).end(); return }
      pending.delete(r.id as string)
      clearTimeout(p.timer)
      if (r.ok === true) p.resolve(r.data)
      else p.reject(new Error(String(r.error ?? 'the extension failed').slice(0, 500)))
      res.writeHead(200).end()
    })
  })
  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
  return {
    listening, call, connected,
    close() {
      release(204)
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('the hub is stopping')) }
      pending.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}
