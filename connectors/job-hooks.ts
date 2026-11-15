// A job's own webhook (ADR 0015): POST /hook/<job id> with the job's bearer token wakes that job, and the body reaches it
// quoted as data. Only the token's sha256 is stored. Off unless tripwires.hookPort is set. Reach it through a tunnel.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { quotedLine } from '../core/text.ts'
import { hookTokenHash } from '../core/tripwire.ts'
import type { Inbox } from '../runtime/store.ts'
import { bearerOk, hourCap, readBody } from './webhook.ts'

const PATH = /^\/hook\/([\w-]+)$/

export function jobHooks(o: {
  host: string; port: number; inbox: Inbox
  maxKb: () => number; perHour: () => number
  hookOf: (job: string) => { key: string; tokenHash: string } | undefined   // the job's thread and stored token hash, read each call so an unscheduled job stops at once
  deliver: (job: string, quote: string, done: () => void) => void           // wake the job's lane; done once it is handed over
  track: (who: string, detail: string) => void
}) {
  const caps = new Map<string, ReturnType<typeof hourCap>>()   // per job; a job's cap leaves with the hub
  const reply = (res: import('node:http').ServerResponse, job: string, key: string | undefined, status: number) => {
    o.track(key ?? 'hub', `hook job=${job} status=${status}`)
    res.writeHead(status).end()
  }
  // The call stays in the inbox until the job's run has it, so a crash in between replays it (hub/connectors.ts).
  const run = (source: string, job: string, body: string) => {
    if (!o.hookOf(job)) return o.inbox.handled(source)   // the job is gone
    o.deliver(job, quotedLine(body), () => o.inbox.handled(source))
  }
  const server = createServer((req, res) => {
    const job = PATH.exec(req.url ?? '')?.[1]
    if (req.method !== 'POST' || !job) return reply(res, job ?? '-', undefined, 404)
    void (async () => {
      const hook = o.hookOf(job)
      // The token is compared by hash, through the shared bearer check ("Bearer <hash>" against "Bearer <stored hash>").
      const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
      if (!hook || !bearerOk(`Bearer ${hookTokenHash(presented)}`, hook.tokenHash)) return reply(res, job, hook?.key, 401)
      const cap = caps.get(job) ?? caps.set(job, hourCap(o.perHour())).get(job)!
      const now = Date.now()
      if (cap.full(now)) return reply(res, job, hook.key, 429)
      const raw = await readBody(req, o.maxKb() * 1024)
      if (!raw) { reply(res, job, hook.key, 413); req.destroy(); return }
      cap.add(now)
      const body = raw.toString('utf8')
      const source = `hook:${randomUUID()}`
      o.inbox.take(source, 'hook', JSON.stringify({ job, body }))   // before the 200: a crash after it replays the call
      reply(res, job, hook.key, 200)
      run(source, job, body)
    })().catch(() => { try { reply(res, job, undefined, 500) } catch {} })
  })
  const listening = new Promise<number>(ok => server.listen(o.port, o.host, () => ok((server.address() as AddressInfo).port)))
  // A call the last run took but never handed to its job, from the inbox.
  const replay = async (source: string, payload: string) => { const { job, body } = JSON.parse(payload) as { job: string; body: string }; run(source, job, body) }
  return { listening, replay, close: () => { server.close(); server.closeAllConnections() } }
}
