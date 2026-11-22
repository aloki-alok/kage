import type { ServerResponse } from 'node:http'
import { log } from '../runtime/log.ts'
import type { Conversation } from '../core/conversations.ts'
import { campaignReport, inSendWindow, smsKeyword, smsSegments, smsTaskLine } from '../core/sms.ts'
import { telnyxEvent, telnyxSigned, twilioEvent, twilioSigned, type SmsEvent } from '../core/sms-providers.ts'
import { startFailedNote, type Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import { taskAsOther } from '../core/gate.ts'
import { ownerLines } from '../core/messages.ts'
import type { Inbox } from '../runtime/store.ts'
import type { SmsStore } from '../runtime/sms-store.ts'
import type { SmsProvider, SmsSend, SmsSent } from './sms-send.ts'
import { hourCap, listen, readBody } from './webhook.ts'

const MAX_BODY = 64_000
const OUTSIDER = 'a person who texted the SMS number'
const REPORT_TRIES = 3
type Inbound = Extract<SmsEvent, { kind: 'inbound' }>

type SmsOptions = {
  provider: SmsProvider; from: string; port: number; publicUrl: string; perHour: number; perMinute: number; tickMs?: number
  twilioAuthToken?: string; telnyxPublicKey?: string
  send: SmsSend; store: SmsStore; inbox: Inbox
  deliver: (c: Conversation, task: Task, place: string) => Delivery
  notify: (text: string) => void
  post: (thread: string, text: string) => Promise<boolean>
  startError?: () => string | undefined
  clock?: () => Date
}
const placeOf = (person: number) => `SMS contact ${person}`

export function connectSms(o: SmsOptions) {
  const hear = textHearer(o)
  const run = (e: SmsEvent, source?: string) => {
    if (e.kind === 'status') { o.store.status(e.id, e.status, e.error); return }
    if (e.to !== o.from || !source) return
    try { hear(e, source) } finally { o.inbox.handled(source) }
  }
  const server = webhook(o, run)
  const sendOne = (to: string, body: string): Promise<SmsSent> =>
    o.send(to, o.from, body).catch(e => { log('sms send failed', e); return { error: 'network', auth: false, again: false } })
  const tick = campaignSender(o, sendOne)
  const timer = o.tickMs === 0 ? undefined : setInterval(() => void tick(), o.tickMs ?? 60_000)
  timer?.unref()
  const replay = async (source: string, payload: string) => { run(JSON.parse(payload) as SmsEvent, source) }
  return { listening: server.listening, replay, reply: replier(o, sendOne), tick, close: () => { if (timer) clearInterval(timer); server.close() } }
}

function textHearer(o: SmsOptions) {
  const cap = hourCap(o.perHour)
  return (e: Inbound, source: string) => {
    const keyword = smsKeyword(e.text)
    const heard = o.store.heard(e.from, e.id, keyword)
    if (!heard.fresh) return
    log('sms text in', keyword ?? 'text')
    if (keyword) return
    const now = Date.now()
    if (cap.full(now)) { if (cap.tell()) o.notify(ownerLines.smsOverCap(o.perHour)); return }
    cap.add(now)
    const campaign = heard.campaign === undefined ? undefined : o.store.campaign(heard.campaign)
    const chat = String(heard.person), place = placeOf(heard.person)
    const task = { ...taskAsOther({
      content: smsTaskLine(e.text, campaign),
      meta: { channel: 'sms', thread_ts: chat, place, permalink: '' },
      origin: { channel: 'sms', ts: chat }, source,
    }), outsider: OUTSIDER }
    if (o.deliver({ connector: 'sms', chat, kind: 'chat' }, task, place) === 'failed') o.notify(startFailedNote(place, o.startError?.()))
  }
}

function signedEvent(o: SmsOptions, raw: Buffer, headers: Record<string, string | string[] | undefined>): SmsEvent | undefined | false {
  const header = (name: string) => (typeof headers[name] === 'string' ? headers[name] as string : undefined)
  if (o.provider === 'twilio') {
    const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
    return twilioSigned(o.twilioAuthToken ?? '', o.publicUrl, params, header('x-twilio-signature')) && twilioEvent(params)
  }
  if (!telnyxSigned(o.telnyxPublicKey ?? '', header('telnyx-timestamp'), raw, header('telnyx-signature-ed25519'), Date.now() / 1000)) return false
  try { return telnyxEvent(JSON.parse(raw.toString('utf8'))) } catch { return undefined }
}

function webhook(o: SmsOptions, run: (e: SmsEvent, source?: string) => void) {
  const ok = (res: ServerResponse) => {
    if (o.provider === 'twilio') res.writeHead(200, { 'content-type': 'text/xml' }).end('<Response></Response>')
    else res.writeHead(200).end()
  }
  return listen((req, res) => {
    if (req.method !== 'POST' || req.url !== '/sms') { res.writeHead(404).end(); return }
    void (async () => {
      const raw = await readBody(req, MAX_BODY)
      if (!raw) { res.writeHead(413).end(); req.destroy(); return }
      const e = signedEvent(o, raw, req.headers)
      if (e === false) { res.writeHead(401).end(); return }
      if (!e) { ok(res); return }
      const source = e.kind === 'inbound' ? `sms:${e.id}` : undefined
      if (source && !o.inbox.take(source, 'sms', JSON.stringify(e))) { ok(res); return }
      try { run(e, source); ok(res) } catch (err) { log('sms event failed', err); res.writeHead(500).end() }
    })()
  }, o.port)
}

function replier(o: SmsOptions, sendOne: (to: string, body: string) => Promise<SmsSent>) {
  return async (key: string, text: string): Promise<boolean> => {
    const person = Number(key.slice('sms:'.length))
    const phone = o.store.phoneOf(person)
    const row = phone === undefined ? undefined : o.store.claim(null, person, smsSegments(text).segments)
    if (phone === undefined || row === undefined) { log('sms reply refused: unknown or opted-out contact', person); return false }
    const r = await sendOne(phone, text)
    if ('id' in r) { o.store.accepted(row, r.id); return true }
    o.store.refused(row, r.error)
    o.notify(ownerLines.smsReplyFailed(placeOf(person), r.error))
    return false
  }
}

function campaignSender(o: SmsOptions, sendOne: (to: string, body: string) => Promise<SmsSent>) {
  const clock = o.clock ?? (() => new Date())
  const failedPosts = new Map<number, number>()
  async function reportSent() {
    for (const id of o.store.sentCampaigns()) {
      const c = o.store.campaign(id), numbers = o.store.report(id)
      if (!c || !numbers) continue
      const report = campaignReport({ ...numbers, state: 'done' })
      if (await o.post(c.thread, report)) { failedPosts.delete(id); o.store.move(id, 'finish'); continue }
      const tries = (failedPosts.get(id) ?? 0) + 1
      log('sms campaign report not posted', id, tries)
      if (tries < REPORT_TRIES) { failedPosts.set(id, tries); continue }
      failedPosts.delete(id)
      o.notify(ownerLines.smsReportUnposted(tries, report))
      o.store.move(id, 'finish')
    }
  }
  async function sendBatch() {
    const batch = o.store.nextBatch(o.perMinute)
    for (const b of batch) {
      if (!inSendWindow(clock())) return
      const row = o.store.claim(b.campaign, b.person, smsSegments(b.body).segments)
      if (row === undefined) continue
      const r = await sendOne(b.phone, b.body)
      if ('id' in r) { o.store.accepted(row, r.id); continue }
      if (!r.again) { o.store.refused(row, r.error); continue }
      o.store.release(row)
      if (!r.auth) return
      for (const id of new Set(batch.map(x => x.campaign))) o.store.move(id, 'pause')
      o.notify(ownerLines.smsAuthFailed(r.error))
      return
    }
  }
  let running: Promise<void> | undefined, reporting: Promise<void> | undefined
  return () => {
    reporting ??= reportSent().catch(e => log('sms report failed', e)).finally(() => { reporting = undefined })
    running ??= sendBatch().catch(e => log('sms tick failed', e)).finally(() => { running = undefined })
    return Promise.all([reporting, running]).then(() => undefined)
  }
}
