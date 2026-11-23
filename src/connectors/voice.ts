import { oneLine } from '../core/text.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { log } from '../runtime/log.ts'
import type { Conversation } from '../core/conversations.ts'
import { taskAsOther, taskAsOwner, voiceTaskLine } from '../core/gate.ts'
import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import { bearerOk, hourCap, listen, readBody } from './webhook.ts'

const MAX_QUESTION = 600
const STILL = 'Kage is still working on it. Ask again in a moment and you will get the answer.'
const FAILED = 'Kage could not start a session for this call right now. Try again later.'

function ownerVoiceTaskLine(question: string): string {
  return 'Voice task from the owner (a call Kage placed to the owner, verified by a one-time code): do what the owner asks, with your normal tools, approvals and context. For a one-way step (a production write, a delete, money, an outside send, an access grant, a protected merge, a commitment), do not do it: say it needs their yes in Slack, because a misheard word is easy to act on. '
    + 'Your reply is spoken: answer in one to three short spoken sentences, plain words, no markdown, no links. For long work, say what you are doing and reply when done. '
    + `The owner's words, as heard: ${JSON.stringify(oneLine(question))}`
}

async function readJson(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const body = await readBody(req, max)
  if (!body) throw new Error('too large')
  return JSON.parse(body.toString('utf8'))
}

const BUSY = 'Kage is busy, try again shortly.'
const IDLE_MS = 3 * 60_000
const CODE_MS = 10 * 60_000
const same = ' (That answers your earlier question. Ask your new one again.)'

type Options = {
  voice: Voice
  name: string
  deliver: (c: Conversation, task: Task, place: string) => Delivery
  failed: (task: Task) => void
  slot?: (key: string) => boolean
  end?: (key: string) => void
  waitMs?: number
  now?: () => number
}
type Call = { inflight: boolean; answers: string[]; wake: Set<() => void>; last: number; sent: number; noted: boolean }
type Book = {
  o: Options; waitMs: number; now: () => number; maxCalls: number; cap: ReturnType<typeof hourCap>
  calls: Map<string, Call>; codes: Map<string, number>; owners: Set<string>
}
type Sessions = ReturnType<typeof mcpSessions>

export type Voice = { token?: string | null; on?: boolean; max?: number; perHour?: number; port?: number }
export function connectVoice(o: Options) {
  const { token, on, max, perHour, port } = o.voice
  if (on === false || !token) return undefined
  const b: Book = {
    o, waitMs: o.waitMs ?? 20_000, now: o.now ?? Date.now, maxCalls: max || 1, cap: hourCap(perHour || 20),
    calls: new Map(), codes: new Map(), owners: new Set(),
  }
  const s = mcpSessions(b)
  const { server, listening } = listen(voiceRoute(token, s), port ?? 8787)
  const sweep = async () => {
    for (const [k, c] of [...b.calls]) if (b.now() - c.last >= IDLE_MS) endCall(b, k)
    await s.sweep()
  }
  const timer = setInterval(() => void sweep(), 60_000)
  timer.unref()
  void listening.then(p => log(`voice on: 127.0.0.1:${p}`), e => log('voice could not listen', e))
  return {
    reply: (key: string, text: string) => reply(b, key, text), listening, sweep, issueCode: () => issueCode(b),
    calls: () => b.calls.size, sessions: () => s.sessions.size,
    address: () => (server.address() as AddressInfo).address,
    async close() {
      clearInterval(timer)
      for (const t of s.sessions.values()) await t.close().catch(() => {})
      server.closeAllConnections()
      await new Promise(r => server.close(r))
    },
  }
}

function issueCode(b: Book) {
  for (const [c, until] of b.codes) if (until < b.now()) b.codes.delete(c)
  const code = randomBytes(16).toString('hex')
  b.codes.set(code, b.now() + CODE_MS)
  return code
}

function claim(b: Book, key: string, code: string | undefined) {
  const until = code ? b.codes.get(code) : undefined
  if (until === undefined) return
  b.codes.delete(code!)
  if (until >= b.now()) b.owners.add(key)
}

function reply(b: Book, key: string, text: string) {
  const c = b.calls.get(key)
  if (!c) return
  c.answers.push(text)
  c.inflight = false
  for (const w of [...c.wake]) w()
}

const wait = (b: Book, c: Call) => new Promise<void>(res => {
  const done = () => { clearTimeout(timer); c.wake.delete(done); res() }
  const timer = setTimeout(done, b.waitMs)
  c.wake.add(done)
})

async function ask(b: Book, id: string, question: string, code?: string): Promise<string> {
  const key = `voice:${id}`
  claim(b, key, code)
  const owner = b.owners.has(key)
  let c = b.calls.get(key)
  const lost = !!c && c.inflight && b.now() - c.sent > b.waitMs * 2 + 30_000
  const fresh = !c || (!c.answers.length && (!c.inflight || lost))
  if (fresh) {
    const started = startCall(b, c, { id, key, question, owner })
    if (typeof started === 'string') return started
    c = started
  }
  if (!c!.answers.length) await wait(b, c!)
  c!.last = b.now()
  if (c!.answers.length) return c!.answers.splice(0).join(' ') + (fresh ? '' : same)
  return STILL
}

function startCall(b: Book, c: Call | undefined, p: { id: string; key: string; question: string; owner: boolean }): Call | string {
  const { o, now } = b
  if (!c) {
    if (b.calls.size >= b.maxCalls || b.cap.full(now())) return BUSY
  }
  if (o.slot && !o.slot(p.key)) return BUSY
  if (!c) {
    c = { inflight: false, answers: [], wake: new Set(), last: now(), sent: 0, noted: false }
    b.calls.set(p.key, c)
    b.cap.add(now())
  }
  const place = `voice call ${p.id.slice(0, 8)}`
  const task = (p.owner ? taskAsOwner : taskAsOther)({
    content: [p.owner ? ownerVoiceTaskLine(p.question) : voiceTaskLine(p.question), `Reply with the reply tool, channel "voice" and thread_ts "${p.key}". It is spoken to the caller.`].join('\n'),
    meta: { channel: 'voice', thread_ts: p.key, place, permalink: '' },
    origin: { channel: 'voice', ts: p.key },
  })
  log('voice task for', place)
  c.last = c.sent = now()
  c.inflight = true
  if (o.deliver({ connector: 'voice', chat: p.id, kind: 'chat' }, task, place) === 'failed') {
    c.inflight = false
    if (!c.noted) { c.noted = true; o.failed(task) }
    return FAILED
  }
  return c
}

function endCall(b: Book, key: string) {
  b.owners.delete(key)
  const c = b.calls.get(key)
  if (!c) return
  b.calls.delete(key)
  for (const wake of [...c.wake]) wake()
  b.o.end?.(key)
}

function mcpSessions(b: Book) {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const seen = new Map<string, number>()
  const name = b.o.name
  function open() {
    const mcp = new McpServer({ name, version: '1' })
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessions.set(id, transport); seen.set(id, b.now()) },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (!id) return
      sessions.delete(id)
      seen.delete(id)
      endCall(b, `voice:${id}`)
    }
    mcp.registerTool('ask_kage', {
      description: `Ask ${name} one question and get a short answer to speak. If it says ${name} is still working, ask again in a moment.`,
      inputSchema: {
        question: z.string().trim().min(1).max(MAX_QUESTION).describe(`The question, ${MAX_QUESTION} characters at most`),
        owner_code: z.string().max(64).optional().describe('The call code you were given for this call, if any. Never say it aloud.'),
      },
    }, async ({ question, owner_code }) => ({ content: [{ type: 'text' as const, text: await ask(b, transport.sessionId!, question, owner_code) }] }))
    void mcp.connect(transport)
    return transport
  }
  async function ended(id: string) {
    const t = sessions.get(id)
    sessions.delete(id)
    seen.delete(id)
    endCall(b, `voice:${id}`)
    await t?.close()
  }
  async function sweep() {
    for (const [id, t] of [...sessions]) if (b.now() - (seen.get(id) ?? 0) >= IDLE_MS) { await t.close().catch(() => {}); sessions.delete(id); seen.delete(id) }
  }
  const touch = (id: string) => seen.set(id, b.now())
  return { sessions, open, ended, sweep, touch }
}

function voiceRoute(token: string, s: Sessions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!bearerOk(req.headers.authorization, token)) { res.writeHead(401).end(); return }
    try {
      if (req.method === 'POST' && req.url === '/voice/ended') {
        const body = await readJson(req) as { call_id?: unknown; session_id?: unknown } | null
        const id = body?.call_id ?? body?.session_id ?? req.headers['mcp-session-id']
        if (typeof id !== 'string' || !id.trim()) { res.writeHead(400).end(); return }
        await s.ended(id)
        res.writeHead(204).end()
        return
      }
      const sid = req.headers['mcp-session-id']
      let transport = typeof sid === 'string' ? s.sessions.get(sid) : undefined
      const body = req.method === 'POST' ? await readJson(req) : undefined
      if (!transport) {
        if (sid || !isInitializeRequest(body)) { res.writeHead(404).end(); return }
        transport = s.open()
      }
      if (transport.sessionId) s.touch(transport.sessionId)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log('voice request failed', e)
      if (!res.headersSent) res.writeHead(400).end()
    }
  }
}
