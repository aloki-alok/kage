// Voice connector: a voice agent on a call asks Kage one question through one MCP tool (ask_kage)
// and speaks the answer. Each MCP session is one call, and one call is one Kage session.
// A voice task is a stranger (anyone may be on the call): core/gate.ts senderOf and core/guards.ts
// voiceToolRefusal enforce it. The one exception is a call Kage placed to the owner itself: `kage call`
// gets a one-time code (issueCode), the dialer hands it to the agent, and the first call that asks with
// it is the owner for its whole length. Caller ID is never trusted: anyone can fake a number. The reply comes back through replies.voice in hub/router.ts.
import { oneLine } from '../core/text.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
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

export const MAX_QUESTION = 600
const STILL = 'Kage is still working on it. Ask again in a moment and you will get the answer.'
const FAILED = 'Kage could not start a session for this call right now. Try again later.'

// The owner placed this call, so it gets the owner's tools and approvals; only the spoken style differs.
export function ownerVoiceTaskLine(question: string): string {
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
// A phone agent that hangs up often sends no DELETE, so a call with no ask for this long is over.
const IDLE_MS = 3 * 60_000
const CODE_MS = 10 * 60_000   // a code not used by a call within this is dead
const same = ' (That answers your earlier question. Ask your new one again.)'

// On when voiceToken is set, unless connectors.voice.on is false (the kill switch).
// slot: whether a task for this key would start without evicting or jumping ahead of another thread
// (Dispatcher.hasFreeSlot). A call that cannot get one is told Kage is busy, so it never costs the owner a slot.
// The voice token (secrets.json) and connectors.voice (config.json).
export type Voice = { token?: string | null; on?: boolean; max?: number; perHour?: number; port?: number }
export function connectVoice(o: {
  voice: Voice
  name: string
  deliver: (c: Conversation, task: Task, place: string) => Delivery
  failed: (task: Task) => void
  slot?: (key: string) => boolean
  end?: (key: string) => void   // a call is over: end its Kage session (Dispatcher.end)
  waitMs?: number
  now?: () => number
}) {
  const { token, on, max, perHour: perHourSetting, port: portSetting } = o.voice
  if (on === false || !token) return undefined
  const waitMs = o.waitMs ?? 20_000
  const now = o.now ?? Date.now
  const maxCalls = max || 1
  const perHour = perHourSetting || 20
  // A call has one question in flight at a time. Replies belong to it and wait in `answers` until an
  // ask returns them: the first reply ends the question, any more are kept for the next ask.
  type Call = { inflight: boolean; answers: string[]; wake: Set<() => void>; last: number; sent: number; noted: boolean }
  const calls = new Map<string, Call>()
  const cap = hourCap(perHour)
  const codes = new Map<string, number>()   // unused one-time codes to their deadline
  const owners = new Set<string>()          // calls (voice:<id>) that came with a code

  function issueCode() {
    for (const [c, until] of codes) if (until < now()) codes.delete(c)
    const code = randomBytes(16).toString('hex')
    codes.set(code, now() + CODE_MS)
    return code
  }

  // A live code is spent by the first call that brings it: that call is the owner until it ends.
  function claim(key: string, code: string | undefined) {
    const until = code ? codes.get(code) : undefined
    if (until === undefined) return
    codes.delete(code!)
    if (until >= now()) owners.add(key)
  }

  // The router's replies.voice: a session's reply for this call. A call that is gone drops it.
  function reply(key: string, text: string) {
    const c = calls.get(key)
    if (!c) return
    c.answers.push(text)
    c.inflight = false
    for (const w of [...c.wake]) w()
  }

  const wait = (c: Call) => new Promise<void>(res => {
    const done = () => { clearTimeout(timer); c.wake.delete(done); res() }
    const timer = setTimeout(done, waitMs)
    c.wake.add(done)
  })

  async function ask(id: string, question: string, code?: string): Promise<string> {
    const key = `voice:${id}`
    claim(key, code)
    const owner = owners.has(key)
    let c = calls.get(key)
    // A question in flight past this deadline lost its session (died, evicted): it counts as over.
    const lost = !!c && c.inflight && now() - c.sent > waitMs * 2 + 30_000
    const fresh = !c || (!c.answers.length && (!c.inflight || lost))
    if (fresh) {
      // Whether this question may start at all: a new call needs a free call slot and hourly budget,
      // and any start must not evict or jump ahead of another thread.
      if (!c) {
        if (calls.size >= maxCalls || cap.full(now())) return BUSY
      }
      if (o.slot && !o.slot(key)) return BUSY
      if (!c) {
        c = { inflight: false, answers: [], wake: new Set(), last: now(), sent: 0, noted: false }
        calls.set(key, c)
        cap.add(now())
      }
      const place = `voice call ${id.slice(0, 8)}`
      const task = (owner ? taskAsOwner : taskAsOther)({
        content: [owner ? ownerVoiceTaskLine(question) : voiceTaskLine(question), `Reply with the reply tool, channel "voice" and thread_ts "${key}". It is spoken to the caller.`].join('\n'),
        meta: { channel: 'voice', thread_ts: key, place, permalink: '' },
        origin: { channel: 'voice', ts: key },
      })
      log('voice task for', place)
      c.last = c.sent = now()
      c.inflight = true
      if (o.deliver({ connector: 'voice', chat: id, kind: 'chat' }, task, place) === 'failed') {
        c.inflight = false
        // One note to the owner per call, however often the caller asks again.
        if (!c.noted) { c.noted = true; o.failed(task) }
        return FAILED
      }
    }
    if (!c!.answers.length) await wait(c!)
    c!.last = now()
    if (c!.answers.length) return c!.answers.splice(0).join(' ') + (fresh ? '' : same)
    return STILL
  }

  const endCall = (key: string) => {
    owners.delete(key)
    const c = calls.get(key)
    if (!c) return
    calls.delete(key)
    for (const wake of [...c.wake]) wake()
    o.end?.(key)
  }

  // Drops calls and MCP sessions idle for 3 minutes: their slot, memory and Kage session come back.
  async function sweep() {
    for (const [k, c] of [...calls]) if (now() - c.last >= IDLE_MS) endCall(k)
    for (const [id, t] of [...sessions]) if (now() - (seen.get(id) ?? 0) >= IDLE_MS) { await t.close().catch(() => {}); sessions.delete(id); seen.delete(id) }
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const seen = new Map<string, number>()   // MCP session id to the last request time
  function newSession() {
    const mcp = new McpServer({ name: o.name, version: '1' })
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessions.set(id, transport); seen.set(id, now()) },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (!id) return
      sessions.delete(id)
      seen.delete(id)
      endCall(`voice:${id}`)   // the call ended: its slot is free
    }
    mcp.registerTool('ask_kage', {
      description: `Ask ${o.name} one question and get a short answer to speak. If it says ${o.name} is still working, ask again in a moment.`,
      inputSchema: {
        question: z.string().trim().min(1).max(MAX_QUESTION).describe(`The question, ${MAX_QUESTION} characters at most`),
        owner_code: z.string().max(64).optional().describe('The call code you were given for this call, if any. Never say it aloud.'),
      },
    }, async ({ question, owner_code }) => ({ content: [{ type: 'text' as const, text: await ask(transport.sessionId!, question, owner_code) }] }))
    void mcp.connect(transport)
    return transport
  }

  const port = portSetting ?? 8787
  const { server, listening } = listen(async (req, res) => {
    // Bare 401, no detail, for anything without the exact token.
    if (!bearerOk(req.headers.authorization, token)) { res.writeHead(401).end(); return }
    try {
      if (req.method === 'POST' && req.url === '/voice/ended') {
        const body = await readJson(req) as { call_id?: unknown; session_id?: unknown } | null
        const id = body?.call_id ?? body?.session_id ?? req.headers['mcp-session-id']
        if (typeof id !== 'string' || !id.trim()) { res.writeHead(400).end(); return }
        const ended = sessions.get(id)
        // Remove it before closing: a retry or onclose must never end the call twice.
        sessions.delete(id)
        seen.delete(id)
        endCall(`voice:${id}`)
        await ended?.close()
        res.writeHead(204).end()
        return
      }
      const sid = req.headers['mcp-session-id']
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined
      const body = req.method === 'POST' ? await readJson(req) : undefined
      if (!transport) {
        if (sid || !isInitializeRequest(body)) { res.writeHead(404).end(); return }
        transport = newSession()
      }
      if (transport.sessionId) seen.set(transport.sessionId, now())
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log('voice request failed', e)
      if (!res.headersSent) res.writeHead(400).end()
    }
  }, port)
  const timer = setInterval(() => void sweep(), 60_000)
  timer.unref()
  void listening.then(p => log(`voice on: 127.0.0.1:${p}`), e => log('voice could not listen', e))
  return {
    reply, listening, sweep, issueCode, calls: () => calls.size, sessions: () => sessions.size,
    address: () => (server.address() as AddressInfo).address,
    async close() {
      clearInterval(timer)
      for (const t of sessions.values()) await t.close().catch(() => {})
      server.closeAllConnections()
      await new Promise(r => server.close(r))
    },
  }
}
