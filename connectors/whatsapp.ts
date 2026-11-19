import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { RequestListener } from 'node:http'
import { log, logRef } from '../runtime/log.ts'
import { DEFAULT_MODEL } from '../core/config.ts'
import { claudeOnce, emptyRoom } from '../runtime/claude-once.ts'
import { listen, readBody } from './webhook.ts'
import type { Inbox } from '../runtime/store.ts'
import { findSecret, guardVerdict } from '../core/outbound.ts'
import type { Job } from '../runtime/jobs.ts'
import { bridgeAlert, decideWhatsApp, fromWaha, guardPrompt, standInPrompt, waOutgoing, waTaskContent, withoutFooter, type Arming, type BridgeSeen, type WahaPayload, type WaLine } from '../core/whatsapp.ts'

export const wahaUrl = (set?: string | null) => set || 'http://127.0.0.1:3198'

export type WaTask = { chat: string; place: string; content: string; source?: string }
const ARM_MS = 60 * 60_000

const MAX_BODY = 1_000_000

export function wahaIntake(body: string, inbox: Inbox): { source?: string; payload: WahaPayload } | undefined {
  const e = JSON.parse(body) as { event?: string; payload?: WahaPayload }
  if (e.event !== 'message.any' || !e.payload) return undefined
  const source = e.payload.id ? `wa:${e.payload.id}` : undefined
  if (source && !inbox.take(source, 'whatsapp', JSON.stringify(e.payload))) return undefined
  return { source, payload: e.payload }
}

const signed = (hmac: string, body: Buffer, given: string) => {
  const want = Buffer.from(createHmac('sha512', hmac).update(body).digest('hex'))
  const got = Buffer.from(given)
  return want.length === got.length && timingSafeEqual(want, got)
}

export function wahaHandler(hmac: string, inbox: Inbox, run: (p: WahaPayload, source?: string) => unknown, max = MAX_BODY): RequestListener {
  if (!hmac) throw new Error('the WAHA webhook needs an HMAC key')
  return (req, res) => {
    const given = req.headers['x-webhook-hmac']
    if (req.method !== 'POST' || req.url !== '/waha') { res.writeHead(404).end(); return }
    if (typeof given !== 'string' || !given) { res.writeHead(401).end(); return }
    void (async () => {
      const body = await readBody(req, max)
      if (!body) { res.writeHead(413).end(); req.destroy(); return }
      if (!signed(hmac, body, given)) { res.writeHead(401).end(); return }
      let got: ReturnType<typeof wahaIntake>
      try { got = wahaIntake(body.toString(), inbox) } catch (err) { log('whatsapp bad event', err); res.writeHead(400).end(); return }
      res.writeHead(200).end()
      if (got) void run(got.payload, got.source)
    })()
  }
}

export function startWhatsApp(o: { dir: string; name: string; owner: string; waha: Record<string, string>; whatsapp: { wahaUrl?: string | null; model?: string | null; hookHost?: string | null; hookPort?: number }; memory: string; inbox: Inbox; onTask: (t: WaTask) => void; notify: (text: string) => void }) {
  const waha = o.waha
  const URL = wahaUrl(o.whatsapp.wahaUrl)
  const HMAC = waha.WHATSAPP_HOOK_HMAC_KEY
  if (!HMAC) throw new Error('secrets.json waha has no WHATSAPP_HOOK_HMAC_KEY: the webhook would have no secret')
  const MODEL = o.whatsapp.model || DEFAULT_MODEL
  const ROOM = emptyRoom(o.dir)
  mkdirSync(o.memory, { recursive: true, mode: 0o700 })

  const armed = new Map<string, Arming & { brief: string }>()
  const busy = new Map<string, boolean>()

  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(URL + path, { ...init, headers: { 'X-Api-Key': waha.WAHA_API_KEY!, 'Content-Type': 'application/json' } })
    if (!r.ok) throw new Error(`WAHA ${path} ${r.status}`)
    return r.json() as Promise<any>
  }
  async function history(chat: string): Promise<WaLine[]> {
    const rows = await api(`/api/default/chats/${encodeURIComponent(chat)}/messages?limit=50&downloadMedia=false`).catch(() => []) as { fromMe?: boolean; body?: string; timestamp?: number }[]
    return rows.filter(r => r.body).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).map(r => ({ fromMe: !!r.fromMe, text: withoutFooter(r.body!) }))
  }
  async function send(chat: string, text: string, hist?: WaLine[]) {
    const brief = armed.get(chat)?.brief ?? ''
    const { system, prompt } = guardPrompt(brief, hist ?? await history(chat), text, o.owner)
    const verdict = findSecret(text) ? { send: false, reason: 'looks like a key or secret' } : guardVerdict(await claudeOnce({ model: MODEL, system, prompt, cwd: ROOM, tools: '' }))
    if (!verdict.send) {
      log('whatsapp message held in', logRef(chat))
      o.notify(`Held a WhatsApp message to ${chat.split('@')[0]} (${verdict.reason}). Send it yourself if it is fine:\n${text}`)
      return 'held'
    }
    await sendText(chat, waOutgoing(text, `${o.name[0]!.toUpperCase()}${o.name.slice(1)}`))
    return 'sent'
  }
  const sendText = (chatId: string, text: string) => api('/api/sendText', { method: 'POST', body: JSON.stringify({ session: 'default', chatId, text }) })

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
        const text = await claudeOnce({ model: MODEL, system, prompt, cwd: o.memory, tools: 'Read,Grep,Glob' })
        if (!text || !armed.has(chat)) continue
        a.replies++
        log('whatsapp stand-in', await send(chat, text, hist), 'in', logRef(chat), `(${a.replies})`)
      } while (busy.get(chat))
    } catch (e) { log('whatsapp stand-in failed in', logRef(chat), e) } finally { busy.delete(chat) }
  }

  async function onEvent(p: WahaPayload, source?: string, replayed = false) {
    const m = fromWaha(p)
    if (!m.chat) return
    const action = decideWhatsApp(m, armed, o.name, Date.now())
    if (action.kind === 'ignore') return
    log('whatsapp', action.kind, logRef(m.chat))
    if (action.kind === 'disarm') { armed.delete(action.chat); return }
    if (action.kind === 'stand-in') { void standIn(action.chat); return }
    if (!replayed) armed.set(action.chat, { until: Date.now() + ARM_MS, replies: 0, brief: action.text })
    const place = `WhatsApp chat ${logRef(action.chat)}`
    o.onTask({ chat: action.chat, place, content: waTaskContent(action.text, place, action.chat, await history(action.chat), o.name, o.owner), ...(source && { source }) })
  }

  const run = (p: WahaPayload, source?: string, replayed = false) => onEvent(p, source, replayed).then(() => { if (source) o.inbox.handled(source) }, err => log('whatsapp event failed', err))
  const HOST = o.whatsapp.hookHost || '127.0.0.1'
  const PORT = o.whatsapp.hookPort || 3199
  void listen(wahaHandler(HMAC, o.inbox, run), PORT, HOST).listening
    .then(() => log(`whatsapp on: listening on ${HOST}:${PORT}`), e => log('whatsapp could not listen', e))

  return {
    send: async (key: string, text: string) => { await send(key.slice('wa:'.length), text) },
    replay: async (source: string, payload: string) => run(JSON.parse(payload) as WahaPayload, source, true),
  }
}

export const wahaToOwner = (_url: string, _key: string, _title: string) => async (_text: string) => false

export async function wahaSeen(url: string, key: string, ms = 5_000): Promise<BridgeSeen> {
  const get = (path: string) => fetch(url + path, { headers: { 'X-Api-Key': key }, signal: AbortSignal.timeout(ms) })
  try {
    const ping = await get('/ping')
    if (!ping.ok) return { reached: true, code: ping.status }
    const r = await get('/api/sessions/default')
    if (!r.ok) return { reached: true, code: r.status }
    return { reached: true, code: r.status, status: ((await r.json()) as { status?: string }).status }
  } catch { return { reached: false } }
}

const DOWN = 'whatsapp-bridge-down'
export function bridgeClock(o: { on: boolean; minutes?: number; look: () => Promise<BridgeSeen>; at: { url: string; qr: string }; state: { load(name: string): unknown; save(name: string, value: unknown): void }; notify: (text: string) => Promise<boolean> }): Job[] {
  if (!o.on) { o.state.save(DOWN, undefined); return [] }
  let starting = false
  return [{ name: 'whatsapp bridge', every: (o.minutes || 5) * 60_000, run: async () => {
    const r = bridgeAlert({ down: o.state.load(DOWN) === true, starting }, await o.look(), o.at)
    if (r.dm) {
      log(`whatsapp bridge ${r.down ? 'down' : 'back'}`)
      if (!(await o.notify(r.dm))) return
    }
    starting = r.starting
    o.state.save(DOWN, r.down || undefined)
  } }]
}
