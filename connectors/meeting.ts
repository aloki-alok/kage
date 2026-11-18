import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../runtime/log.ts'
import type { Conversation } from '../core/conversations.ts'
import { meetingTask, parseMeeting } from '../core/meeting.ts'
import { askOf, askTask, meetCall, meetKey, meetLink, parseSegments, sameQuestion, type Line } from '../core/meetbot.ts'
import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import type { Inbox } from '../runtime/store.ts'
import { slackPlain } from '../core/outbound.ts'
import { bearerOk, hourCap, listen, readBody } from './webhook.ts'
import { taskAsOther } from '../core/gate.ts'

const MAX_BODY = 5_000_000

export function connectMeeting(o: {
  token: string; port: number; botDm: string
  post: (text: string) => Promise<string | undefined>
  deliver: (c: Conversation, task: Task, place: string) => Delivery
  notify: (text: string) => void
  perHour: number
  inbox: Inbox
  untake: (source: string) => void
  name?: string
  end?: (key: string) => void
  askWaitMs?: number
  pollMs?: number
  staleMs?: number
  now?: () => number
}) {
  const now = o.now ?? Date.now
  const pollMs = o.pollMs ?? 25_000, staleMs = o.staleMs ?? 60_000
  const cap = hourCap(o.perHour)
  let chain: Promise<unknown> = Promise.resolve()

  async function handle(body: string, source: string): Promise<'done' | 'bad' | 'retry'> {
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return 'bad' }
    const m = parseMeeting(raw)
    if (!m) return 'bad'
    const t = now()
    if (cap.full(t)) {
      if (cap.tell()) o.notify(`More than ${o.perHour} meeting transcripts came in this hour, so I am skipping them. Send "${m.title}" again after the hour is up.`)
      return 'retry'
    }
    const thread = await o.post(`*Meeting:* ${slackPlain(m.title)}${m.link ? ` <${m.link}|open>` : ''}`)
    if (!thread) { o.notify(`Notes for the meeting "${m.title}" could not open a thread here. Send it again.`); return 'retry' }
    const place = `Meeting ${m.title}`
    const task = taskAsOther({
      content: meetingTask(m),
      meta: { channel: o.botDm, thread_ts: thread, place, permalink: m.link },
      origin: { channel: o.botDm, ts: thread }, source,
    })
    if (o.deliver({ connector: 'slack', chat: o.botDm, thread, kind: 'dm' }, task, place) === 'failed') o.notify(`Could not start a session for ${place}.`)
    cap.add(t)
    return 'done'
  }

  const run = (body: string, source: string) => {
    const next = chain.then(() => handle(body, source)).then(
      r => { if (r === 'done') o.inbox.handled(source); else o.untake(source); return r },
      e => { o.untake(source); throw e })
    chain = next.catch(() => {})
    return next
  }
  type Cmd = { seq: number; at: number } & ({ op: 'join'; link: string } | { op: 'say'; call: string; text: string })
  const cmds: Cmd[] = []
  let seq = now()
  let waiter: { res: ServerResponse; after: number; timer: NodeJS.Timeout } | undefined
  let lastPoll = -Infinity
  const CMD_MS = 5 * 60_000
  const newer = (after: number) => cmds.filter(c => c.seq > after && now() - c.at < CMD_MS)
  const answer = () => {
    if (!waiter) return
    const due = newer(waiter.after)
    if (!due.length) return
    clearTimeout(waiter.timer)
    waiter.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(due))
    waiter = undefined
  }
  function join(link: string): string {
    const url = meetLink(link)
    if (!url) return 'not a Google Meet link (https://meet.google.com/abc-defg-hij)'
    if (!waiter && now() - lastPoll >= staleMs) return 'the meeting bot is not connected: start it on its machine and check it can reach this hub'
    queue({ op: 'join', link: url })
    return ''
  }
  const queue = (c: { op: 'join'; link: string } | { op: 'say'; call: string; text: string }) => {
    cmds.push({ ...c, seq: seq = Math.max(seq + 1, now()), at: now() })
    cmds.splice(0, cmds.length - 20)
    answer()
  }

  const RECENT = 40, LOST_MS = 120_000
  const askWaitMs = o.askWaitMs ?? 2000
  type Live = { recent: Line[]; asked: number; said: string[]; pending?: { speaker: string; text: string; timer: NodeJS.Timeout } }
  const live = new Map<string, Live>()
  const asks = hourCap(o.perHour * 6)
  function heard(call: string, lines: Line[]) {
    const c = live.get(call) ?? { recent: [], asked: 0, said: [] }
    live.set(call, c)
    for (const l of lines) {
      c.recent.push(l)
      c.recent.splice(0, c.recent.length - RECENT)
      if (c.pending && !l.self && l.speaker === c.pending.speaker) {
        c.pending.text += ` ${l.text}`
        clearTimeout(c.pending.timer)
        c.pending.timer = setTimeout(() => ask(call), askWaitMs)
        continue
      }
      const q = o.name ? askOf(l, o.name) : undefined
      if (q && !c.pending) c.pending = { speaker: l.speaker, text: q, timer: setTimeout(() => ask(call), askWaitMs) }
    }
  }
  function ask(call: string) {
    const c = live.get(call)
    const q = c?.pending?.text
    if (!c || !q) return
    c.pending = undefined
    if (now() - c.asked < LOST_MS || asks.full(now()) || c.said.some(s => sameQuestion(s, q))) return
    const key = meetKey(call), place = `Meet ${call}`
    const task = taskAsOther({
      content: askTask(q, c.recent, key),
      meta: { channel: 'voice', thread_ts: key, place, permalink: `https://meet.google.com/${call}` },
      origin: { channel: 'voice', ts: key },
    })
    log('meeting question in', call, `(${q.length} chars)`)
    c.asked = now()
    c.said = [...c.said, q].slice(-20)
    asks.add(now())
    if (o.deliver({ connector: 'voice', chat: `meet-${call}`, kind: 'chat' }, task, place) === 'failed') { c.asked = 0; log('meeting question could not start a session', call) }
  }
  function say(key: string, text: string): boolean {
    const call = meetCall(key)
    if (!call) return false
    const c = live.get(call)
    if (c) c.asked = 0
    log('meeting answer in', call, `(${text.length} chars)`)
    queue({ op: 'say', call, text: text.slice(0, 2000) })
    return true
  }
  function botRoute(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://hub')
    if (req.method === 'GET' && url.pathname === '/meetbot/next') {
      lastPoll = now()
      if (waiter) { clearTimeout(waiter.timer); waiter.res.writeHead(204).end() }
      const after = Number(url.searchParams.get('after')) || 0
      waiter = { res, after, timer: setTimeout(() => { if (waiter?.res === res) { waiter = undefined; res.writeHead(204).end() } }, pollMs) }
      req.on('close', () => { if (waiter?.res === res && !res.writableEnded) { clearTimeout(waiter.timer); waiter = undefined } })
      answer()
      return
    }
    if (req.method === 'POST' && url.pathname === '/meetbot/segments') {
      void readBody(req, 1_000_000).then(raw => {
        if (!raw) { res.writeHead(413).end(); req.destroy(); return }
        let s: ReturnType<typeof parseSegments>
        try { s = parseSegments(JSON.parse(raw.toString('utf8'))) } catch { s = undefined }
        if (!s) { res.writeHead(400).end(); return }
        if (s.lines.length) heard(s.call, s.lines)
        res.writeHead(200).end()
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/meetbot/ended') {
      void readBody(req, 10_000).then(raw => {
        let call: unknown
        try { call = (JSON.parse(raw?.toString('utf8') ?? '') as { call?: unknown }).call } catch {}
        if (typeof call !== 'string' || !/^[a-z0-9-]{1,40}$/.test(call)) { res.writeHead(400).end(); return }
        clearTimeout(live.get(call)?.pending?.timer)
        live.delete(call)
        o.end?.(meetKey(call))
        res.writeHead(200).end()
      })
      return
    }
    res.writeHead(404).end()
  }

  const { listening, close: closeServer } = listen((req, res) => {
    if (!bearerOk(req.headers.authorization, o.token)) { res.writeHead(401).end(); return }
    if (req.url?.startsWith('/meetbot/')) { botRoute(req, res); return }
    if (req.method !== 'POST' || req.url !== '/meeting') { res.writeHead(404).end(); return }
    void (async () => {
      const raw = await readBody(req, MAX_BODY)
      if (!raw) { res.writeHead(413).end(); req.destroy(); return }
      const body = raw.toString('utf8')
      const source = `meeting:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`
      if (!o.inbox.take(source, 'meeting', body)) { res.writeHead(202).end(); return }
      run(body, source)
        .then(r => res.writeHead(r === 'bad' ? 400 : 202).end())
        .catch(e => {
          log('meeting transcript failed', e)
          o.notify(`A meeting transcript failed here (${String(e).slice(0, 120)}). Send it again.`)
          res.writeHead(500).end()
        })
    })()
  }, o.port)
  return {
    listening, join, say, replay: (source: string, body: string) => run(body, source),
    close: () => { for (const c of live.values()) clearTimeout(c.pending?.timer); if (waiter) { clearTimeout(waiter.timer); waiter.res.writeHead(204).end(); waiter = undefined } closeServer() },
  }
}
