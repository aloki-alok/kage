// The WhatsApp side of the router: WAHA (a linked device on the owner's own number) posts every
// message here, signed. whatsapp.ts decides; this module does the I/O.
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { log } from '../config.ts'
import type { Inbox } from '../runtime/store.ts'
import { findSecret } from '../core/outbound.ts'
import { decideWhatsApp, fromWaha, guardPrompt, guardVerdict, standInPrompt, waTaskContent, type Arming, type WahaPayload, type WaLine } from './whatsapp.ts'

export type WaTask = { chat: string; place: string; content: string }
const ARM_MS = 60 * 60_000

// A webhook body above this is refused unread: WAHA events are a few KB.
const MAX_BODY = 1_000_000

// A signed WAHA webhook body, into the inbox before WAHA hears 200: a hub that dies while handling it
// replays it from the store on the next start (router.ts), and a redelivered message id runs once.
// Returns the message to run, or nothing (another event, or a repeat).
export function wahaIntake(body: string, inbox: Inbox): { source?: string; payload: WahaPayload } | undefined {
  const e = JSON.parse(body) as { event?: string; payload?: WahaPayload }
  if (e.event !== 'message.any' || !e.payload) return undefined
  const source = e.payload.id ? `wa:${e.payload.id}` : undefined
  if (source && !inbox.take(source, 'whatsapp', JSON.stringify(e.payload))) return undefined
  return { source, payload: e.payload }
}

export function startWhatsApp(o: { dir: string; name: string; owner: string; env: Record<string, string>; memory: string; inbox: Inbox; onTask: (t: WaTask) => void; notify: (text: string) => void }) {
  const waha = Object.fromEntries(readFileSync(`${o.dir}/waha/.env`, 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const URL = o.env.KAGE_WAHA_URL || 'http://127.0.0.1:3198'
  const HMAC = waha.WHATSAPP_HOOK_HMAC_KEY!
  const MODEL = o.env.KAGE_WA_MODEL || 'sonnet'
  // An empty folder for the guard, so its Claude finds no CLAUDE.md or project memory.
  const ROOM = `${o.dir}/standin`
  mkdirSync(ROOM, { recursive: true, mode: 0o700 })
  mkdirSync(o.memory, { recursive: true, mode: 0o700 })

  const armed = new Map<string, Arming & { brief: string }>()
  const busy = new Map<string, boolean>()

  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(URL + path, { ...init, headers: { 'X-Api-Key': waha.WAHA_API_KEY!, 'Content-Type': 'application/json' } })
    if (!r.ok) throw new Error(`WAHA ${path} ${r.status}`)
    return r.json() as Promise<any>
  }
  async function history(chat: string): Promise<WaLine[]> {
    const rows = await api(`/api/default/chats/${encodeURIComponent(chat)}/messages?limit=20&downloadMedia=false`).catch(() => []) as { fromMe?: boolean; body?: string; timestamp?: number }[]
    return rows.filter(r => r.body).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).map(r => ({ fromMe: !!r.fromMe, text: r.body! }))
  }
  // Every message leaving as the owner passes the key check and the guard first; a held one goes to their DM.
  async function send(chat: string, text: string, hist?: WaLine[]) {
    const brief = armed.get(chat)?.brief ?? ''
    const { system, prompt } = guardPrompt(brief, hist ?? await history(chat), text, o.owner)
    const verdict = findSecret(text) ? { send: false, reason: 'looks like a key or secret' } : guardVerdict(await claude(system, prompt, ROOM, ''))
    if (!verdict.send) {
      log('whatsapp message held', chat, verdict.reason)
      o.notify(`Held a WhatsApp message to ${chat.split('@')[0]} (${verdict.reason}). Send it yourself if it is fine:\n${text}`)
      return 'held'
    }
    await sendText(chat, text)
    return 'sent'
  }
  const sendText = (chatId: string, text: string) => api('/api/sendText', { method: 'POST', body: JSON.stringify({ session: 'default', chatId, text }) })

  // No MCP, no settings (so no CLAUDE.md, hooks or allow rules), nothing saved. In -p mode a read
  // outside cwd is denied (tested 2026-11-03), so read-only tools reach only the folder given.
  function claude(system: string, prompt: string, cwd: string, tools: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn('claude', ['-p', '--tools', tools, '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
        '--model', MODEL, '--system-prompt', system], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', c => { out += c })
      const timer = setTimeout(() => p.kill(), 120_000)
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}`)) })
      p.stdin.end(prompt)
    })
  }

  // One stand-in reply at a time per chat; messages that land meanwhile get one more pass.
  async function standIn(chat: string) {
    if (busy.get(chat) !== undefined) { busy.set(chat, true); return }
    busy.set(chat, false)
    try {
      do {
        busy.set(chat, false)
        const a = armed.get(chat)
        if (!a) break
        const hist = await history(chat)
        const { system, prompt } = standInPrompt(a.brief, hist, o.name, o.owner)
        const text = await claude(system, prompt, o.memory, 'Read,Grep,Glob')
        if (!text || !armed.has(chat)) continue
        a.replies++
        log('whatsapp stand-in', await send(chat, text, hist), 'in', chat, `(${a.replies})`)
      } while (busy.get(chat))
    } catch (e) { log('whatsapp stand-in failed', chat, e) } finally { busy.delete(chat) }
  }

  async function onEvent(p: WahaPayload) {
    const m = fromWaha(p)
    if (!m.chat) return
    const action = decideWhatsApp(m, armed, o.name, Date.now())
    if (action.kind === 'ignore') return
    log('whatsapp', action.kind, m.chat)
    if (action.kind === 'disarm') { armed.delete(action.chat); return }
    if (action.kind === 'stand-in') { void standIn(action.chat); return }
    armed.set(action.chat, { until: Date.now() + ARM_MS, replies: 0, brief: action.text })
    const place = `WhatsApp ${action.chat.split('@')[0]}`
    o.onTask({ chat: action.chat, place, content: waTaskContent(action.text, place, action.chat, await history(action.chat), o.name, o.owner) })
  }

  // A failed event stays unhandled, so the next start tries it again.
  const run = (p: WahaPayload, source?: string) => onEvent(p).then(() => { if (source) o.inbox.handled(source) }, err => log('whatsapp event failed', err))
  const signed = (body: Buffer, given?: string) => {
    if (!given) return false
    const want = Buffer.from(createHmac('sha512', HMAC).update(body).digest('hex'))
    const got = Buffer.from(given)
    return want.length === got.length && timingSafeEqual(want, got)
  }
  // Localhost by default. A WAHA container that reaches the host through a VM gateway needs
  // KAGE_WA_HOOK_HOST=0.0.0.0: then only the HMAC guards it, so keep the port off the internet.
  const HOST = o.env.KAGE_WA_HOOK_HOST || '127.0.0.1'
  const PORT = Number(o.env.KAGE_WA_HOOK_PORT || 3199)
  createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method !== 'POST' || req.url !== '/waha' || !signed(body, req.headers['x-webhook-hmac'] as string | undefined)) { res.writeHead(401).end(); return }
      let got: ReturnType<typeof wahaIntake>
      try { got = wahaIntake(body.toString(), o.inbox) } catch (err) { log('whatsapp bad event', err); res.writeHead(400).end(); return }
      res.writeHead(200).end()
      if (got) void run(got.payload, got.source)
    })
  }).listen(PORT, HOST, () => log(`whatsapp on: listening on ${HOST}:${PORT}`))

  return {
    // A session can send only to its own chat: the key names it.
    send: async (key: string, text: string) => { await send(key.slice('wa:'.length), text) },
    // A message the last run took but never handled, from the inbox.
    replay: async (source: string, payload: string) => run(JSON.parse(payload) as WahaPayload, source),
  }
}
