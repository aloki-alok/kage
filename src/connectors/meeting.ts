import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../runtime/log.ts'
import type { Conversation } from '../core/conversations.ts'
import { meetingTask, parseMeeting } from '../core/meeting.ts'
import { askOf, askTask, meetCall, meetKey, meetLink, parseSegments, sameQuestion, type Line } from '../core/meetbot.ts'
import { startFailedNote, type Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import type { Inbox } from '../runtime/store.ts'
import { slackPlain } from '../core/outbound.ts'
import { bearerOk, hourCap, listen, readBody } from './webhook.ts'
import { taskAsOther } from '../core/gate.ts'
import { ownerLines } from '../core/messages.ts'

const MAX_BODY = 5_000_000
const CMD_MS = 5 * 60_000
const RECENT = 40, LOST_MS = 120_000

type Options = {
  startError?: () => string | undefined
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
}
type Command = { op: 'join'; link: string } | { op: 'say'; call: string; text: string }
type Cmd = { seq: number; at: number } & Command
type Live = { recent: Line[]; asked: number; said: string[]; pending?: { speaker: string; text: string; timer: NodeJS.Timeout } }
type Queue = ReturnType<typeof botQueue>
type Calls = ReturnType<typeof liveCalls>

export function connectMeeting(o: Options) {
  const now = o.now ?? Date.now
  const run = transcripts(o, now)
  const q = botQueue(o, now)
  const calls = liveCalls(o, now, q.queue)
  const { listening, close: closeServer } = listen((req, res) => {
    if (!bearerOk(req.headers.authorization, o.token)) { res.writeHead(401).end(); return }
    if (req.url?.startsWith('/meetbot/')) { botRoute(req, res, q, calls); return }
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
          o.notify(ownerLines.meetingFailed(e))
          res.writeHead(500).end()
        })
    })()
  }, o.port)
  return {
    listening, join: q.join, say: calls.say, replay: (source: string, body: string) => run(body, source),
    close: () => { calls.close(); q.close(); closeServer() },
  }
}

function transcripts(o: Options, now: () => number) {
  const cap = hourCap(o.perHour)
  let chain: Promise<unknown> = Promise.resolve()

  async function handle(body: string, source: string): Promise<'done' | 'bad' | 'retry'> {
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return 'bad' }
    const m = parseMeeting(raw)
    if (!m) return 'bad'
    const t = now()
    if (cap.full(t)) {
      if (cap.tell()) o.notify(ownerLines.meetingOverCap(o.perHour, m.title))
      return 'retry'
    }
    const thread = await o.post(`*Meeting:* ${slackPlain(m.title)}${m.link ? ` <${m.link}|open>` : ''}`)
    if (!thread) { o.notify(ownerLines.meetingNoThread(m.title)); return 'retry' }
    const place = `Meeting ${m.title}`
    const task = taskAsOther({
      content: meetingTask(m),
      meta: { channel: o.botDm, thread_ts: thread, place, permalink: m.link },
      origin: { channel: o.botDm, ts: thread }, source,
    })
    if (o.deliver({ connector: 'slack', chat: o.botDm, thread, kind: 'dm' }, task, place) === 'failed') o.notify(startFailedNote(place, o.startError?.()))
    cap.add(t)
    return 'done'
  }

  return (body: string, source: string) => {
    const next = chain.then(() => handle(body, source)).then(
      r => { if (r === 'done') o.inbox.handled(source); else o.untake(source); return r },
      e => { o.untake(source); throw e })
    chain = next.catch(() => {})
    return next
  }
}

function botQueue(o: Options, now: () => number) {
  const pollMs = o.pollMs ?? 25_000, staleMs = o.staleMs ?? 60_000
  const cmds: Cmd[] = []
  let seq = now()
  let waiter: { res: ServerResponse; after: number; timer: NodeJS.Timeout } | undefined
  let lastPoll = -Infinity
  const newer = (after: number) => cmds.filter(c => c.seq > after && now() - c.at < CMD_MS)
  const answer = () => {
    if (!waiter) return
    const due = newer(waiter.after)
    if (!due.length) return
    clearTimeout(waiter.timer)
    waiter.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(due))
    waiter = undefined
  }
  const queue = (c: Command) => {
    cmds.push({ ...c, seq: seq = Math.max(seq + 1, now()), at: now() })
    cmds.splice(0, cmds.length - 20)
    answer()
  }
  function join(link: string): string {
    const url = meetLink(link)
    if (!url) return 'not a Google Meet link (https://meet.google.com/abc-defg-hij)'
    if (!waiter && now() - lastPoll >= staleMs) return 'the meeting bot is not connected: start it on its machine and check it can reach this hub'
    queue({ op: 'join', link: url })
    return ''
  }
  function poll(req: IncomingMessage, res: ServerResponse, after: number) {
    lastPoll = now()
    if (waiter) { clearTimeout(waiter.timer); waiter.res.writeHead(204).end() }
    waiter = { res, after, timer: setTimeout(() => { if (waiter?.res === res) { waiter = undefined; res.writeHead(204).end() } }, pollMs) }
    req.on('close', () => { if (waiter?.res === res && !res.writableEnded) { clearTimeout(waiter.timer); waiter = undefined } })
    answer()
  }
  const close = () => { if (waiter) { clearTimeout(waiter.timer); waiter.res.writeHead(204).end(); waiter = undefined } }
  return { queue, join, poll, close }
}

function liveCalls(o: Options, now: () => number, queue: (c: Command) => void) {
  const askWaitMs = o.askWaitMs ?? 2000
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
    log('meeting question in', call, `(${q.length} chars)`)
    c.asked = now()
    c.said = [...c.said, q].slice(-20)
    asks.add(now())
    if (o.deliver({ connector: 'voice', chat: `meet-${call}`, kind: 'chat' }, questionTask(call, q, c.recent), `Meet ${call}`) === 'failed') { c.asked = 0; log('meeting question could not start a session', call) }
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
  function ended(call: string) {
    clearTimeout(live.get(call)?.pending?.timer)
    live.delete(call)
    o.end?.(meetKey(call))
  }
  const close = () => { for (const c of live.values()) clearTimeout(c.pending?.timer) }
  return { heard, say, ended, close }
}

function questionTask(call: string, q: string, recent: Line[]) {
  const key = meetKey(call), place = `Meet ${call}`
  return taskAsOther({
    content: askTask(q, recent, key),
    meta: { channel: 'voice', thread_ts: key, place, permalink: `https://meet.google.com/${call}` },
    origin: { channel: 'voice', ts: key },
  })
}

function botRoute(req: IncomingMessage, res: ServerResponse, q: Queue, calls: Calls) {
  const url = new URL(req.url ?? '/', 'http://hub')
  if (req.method === 'GET' && url.pathname === '/meetbot/next') return q.poll(req, res, Number(url.searchParams.get('after')) || 0)
  if (req.method === 'POST' && url.pathname === '/meetbot/segments') return void readBody(req, 1_000_000).then(raw => segments(req, res, raw, calls))
  if (req.method === 'POST' && url.pathname === '/meetbot/ended') return void readBody(req, 10_000).then(raw => ended(res, raw, calls))
  res.writeHead(404).end()
}

function segments(req: IncomingMessage, res: ServerResponse, raw: Buffer | undefined, calls: Calls) {
  if (!raw) { res.writeHead(413).end(); req.destroy(); return }
  let s: ReturnType<typeof parseSegments>
  try { s = parseSegments(JSON.parse(raw.toString('utf8'))) } catch { s = undefined }
  if (!s) { res.writeHead(400).end(); return }
  if (s.lines.length) calls.heard(s.call, s.lines)
  res.writeHead(200).end()
}

function ended(res: ServerResponse, raw: Buffer | undefined, calls: Calls) {
  let call: unknown
  try { call = (JSON.parse(raw?.toString('utf8') ?? '') as { call?: unknown }).call } catch {}
  if (typeof call !== 'string' || !/^[a-z0-9-]{1,40}$/.test(call)) { res.writeHead(400).end(); return }
  calls.ended(call)
  res.writeHead(200).end()
}
