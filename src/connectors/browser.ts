import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bearerOk, listen, readBody } from './webhook.ts'

const MAX_BODY = 20_000_000
export const BROWSER_STALE_MS = 60_000

type Cmd = { id: string; op: string; args: unknown; until: number }
type Options = {
  token: string; port: number
  pollMs?: number
  callMs?: number
  staleMs?: number
  now?: () => number
  onPoll?: (at: number, version?: string) => void
}
type Link = {
  o: Options; now: () => number; pollMs: number; callMs: number; staleMs: number
  queue: Cmd[]; sent: Map<string, Cmd>
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  waiter?: { res: ServerResponse; timer: NodeJS.Timeout }; lastPoll: number
}

export function connectBrowser(o: Options) {
  const l: Link = {
    o, now: o.now ?? Date.now, pollMs: o.pollMs ?? 25_000, callMs: o.callMs ?? 20_000, staleMs: o.staleMs ?? BROWSER_STALE_MS,
    queue: [], sent: new Map(), pending: new Map(), lastPoll: -Infinity,
  }
  const { listening, close: closeServer } = listen((req, res) => {
    if (!bearerOk(req.headers.authorization, o.token)) { res.writeHead(401).end(); return }
    if (req.method === 'GET' && req.url === '/browser/next') { poll(l, req, res); return }
    if (req.method !== 'POST' || req.url !== '/browser/result') { res.writeHead(404).end(); return }
    void readBody(req, MAX_BODY).then(raw => result(l, req, res, raw))
  }, o.port)
  return {
    listening, call: (op: string, args: unknown) => call(l, op, args), connected: () => connected(l),
    close() {
      release(l, 204)
      for (const [, p] of l.pending) { clearTimeout(p.timer); p.reject(new Error('the hub is stopping')) }
      l.pending.clear()
      closeServer()
    },
  }
}

function release(l: Link, status: 204 | 200, body?: string) {
  if (!l.waiter) return
  clearTimeout(l.waiter.timer)
  const { res } = l.waiter
  l.waiter = undefined
  if (status === 204) res.writeHead(204).end()
  else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
}

function flush(l: Link) {
  if (!l.waiter || !l.queue.length) return
  const c = l.queue.shift()!
  l.sent.set(c.id, c)
  const { until, ...cmd } = c
  release(l, 200, JSON.stringify({ ...cmd, ms: Math.max(1, until - l.now()) }))
}

const connected = (l: Link) => !!l.waiter || l.now() - l.lastPoll < l.staleMs

function call(l: Link, op: string, args: unknown): Promise<unknown> {
  if (!connected(l)) return Promise.reject(new Error('the Kage Chrome extension is not connected: install it from the extension folder and paste browserToken into its options'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      l.pending.delete(id)
      l.sent.delete(id)
      const i = l.queue.findIndex(c => c.id === id)
      if (i >= 0) l.queue.splice(i, 1)
      reject(new Error(`the Chrome extension did not answer in ${Math.round(l.callMs / 1000)} s`))
    }, l.callMs)
    l.pending.set(id, { resolve, reject, timer })
    l.queue.push({ id, op, args, until: l.now() + l.callMs })
    flush(l)
  })
}

function poll(l: Link, req: IncomingMessage, res: ServerResponse) {
  l.lastPoll = l.now()
  l.o.onPoll?.(l.lastPoll, String(req.headers['x-kage-extension'] ?? '').slice(0, 20) || undefined)
  release(l, 204)
  l.queue.unshift(...l.sent.values())
  l.sent.clear()
  l.waiter = { res, timer: setTimeout(() => release(l, 204), l.pollMs) }
  req.on('close', () => { if (l.waiter?.res === res && !res.writableEnded) { clearTimeout(l.waiter.timer); l.waiter = undefined } })
  flush(l)
}

function result(l: Link, req: IncomingMessage, res: ServerResponse, raw: Buffer | undefined) {
  if (!raw) { res.writeHead(413).end(); req.destroy(); return }
  if (res.writableEnded) return
  let r: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown }
  try { r = JSON.parse(raw.toString('utf8')) } catch { res.writeHead(400).end(); return }
  const p = typeof r.id === 'string' ? l.pending.get(r.id) : undefined
  if (!p) { res.writeHead(404).end(); return }
  l.pending.delete(r.id as string)
  l.sent.delete(r.id as string)
  clearTimeout(p.timer)
  if (r.ok === true) p.resolve(r.data)
  else p.reject(new Error(String(r.error ?? 'the extension failed').slice(0, 500)))
  res.writeHead(200).end()
}
