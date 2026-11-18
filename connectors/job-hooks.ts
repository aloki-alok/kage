import { randomUUID } from 'node:crypto'
import { quotedLine } from '../core/text.ts'
import { hookTokenHash } from '../core/tripwire.ts'
import type { Inbox } from '../runtime/store.ts'
import { bearerOk, hourCap, listen, readBody } from './webhook.ts'

const PATH = /^\/hook\/([\w-]+)$/

export function jobHooks(o: {
  host: string; port: number; inbox: Inbox
  maxKb: () => number; perHour: () => number
  hookOf: (job: string) => { key: string; tokenHash: string } | undefined
  deliver: (job: string, quote: string, done: () => void) => void
  track: (who: string, detail: string) => void
}) {
  const caps = new Map<string, ReturnType<typeof hourCap>>()
  const reply = (res: import('node:http').ServerResponse, job: string, key: string | undefined, status: number) => {
    o.track(key ?? 'hub', `hook job=${job} status=${status}`)
    res.writeHead(status).end()
  }
  const run = (source: string, job: string, body: string) => {
    if (!o.hookOf(job)) return o.inbox.handled(source)
    o.deliver(job, quotedLine(body), () => o.inbox.handled(source))
  }
  const { listening, close } = listen((req, res) => {
    const job = PATH.exec(req.url ?? '')?.[1]
    if (req.method !== 'POST' || !job) return reply(res, job ?? '-', undefined, 404)
    void (async () => {
      const hook = o.hookOf(job)
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
      o.inbox.take(source, 'hook', JSON.stringify({ job, body }))
      reply(res, job, hook.key, 200)
      run(source, job, body)
    })().catch(() => { try { reply(res, job, undefined, 500) } catch {} })
  }, o.port, o.host)
  const replay = async (source: string, payload: string) => { const { job, body } = JSON.parse(payload) as { job: string; body: string }; run(source, job, body) }
  return { listening, replay, close }
}
