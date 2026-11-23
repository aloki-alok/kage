import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import type { SmsStatus } from './sms.ts'

export type SmsEvent =
  | { kind: 'inbound'; id: string; from: string; to: string; text: string }
  | { kind: 'status'; id: string; status: SmsStatus; error?: string }

export function twilioSigned(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!authToken || !header) return false
  const signed = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  const want = Buffer.from(createHmac('sha1', authToken).update(signed).digest('base64'))
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}

export function twilioBodySigned(authToken: string, url: string, body: string | Buffer, header: string | undefined): boolean {
  const hash = URL.canParse(url) ? new URL(url).searchParams.get('bodySHA256') : null
  if (!hash) return false
  const want = Buffer.from(createHash('sha256').update(body).digest('hex'))
  const got = Buffer.from(hash.toLowerCase())
  return got.length === want.length && timingSafeEqual(got, want) && twilioSigned(authToken, url, {}, header)
}

const INBOUND_EVENT = 'com.twilio.messaging.inbound-message.received'
export function twilioStreamEvents(body: unknown): SmsEvent[] {
  return (Array.isArray(body) ? body : [body]).flatMap(e => {
    const d = (e as { type?: unknown; data?: Record<string, unknown> } | null)?.data
    if ((e as { type?: unknown })?.type !== INBOUND_EVENT || !d || typeof d !== 'object') return []
    const id = str(d.messageSid), from = str(d.from), to = str(d.to)
    return id && from && to && typeof d.body === 'string' ? [{ kind: 'inbound' as const, id, from, to, text: d.body }] : []
  })
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const TELNYX_MAX_AGE_SEC = 300
export function telnyxSigned(publicKey: string, timestamp: string | undefined, body: string | Buffer, header: string | undefined, nowSec: number): boolean {
  if (!publicKey || !timestamp || !header || !(Math.abs(nowSec - Number(timestamp)) <= TELNYX_MAX_AGE_SEC)) return false
  const raw = Buffer.from(publicKey, 'base64')
  if (raw.length !== 32) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })
    return verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(body)]), key, Buffer.from(header, 'base64'))
  } catch { return false }
}

const TWILIO_STATUS: Record<string, SmsStatus> = {
  accepted: 'queued', scheduled: 'queued', queued: 'queued', sending: 'sent', sent: 'sent',
  delivered: 'delivered', read: 'delivered', undelivered: 'undelivered', failed: 'failed', canceled: 'failed',
}
export function twilioEvent(p: Record<string, string>): SmsEvent | undefined {
  if (!p.MessageSid) return
  if (p.MessageStatus) {
    const status = TWILIO_STATUS[p.MessageStatus]
    return status && { kind: 'status', id: p.MessageSid, status, ...(p.ErrorCode && { error: p.ErrorCode }) }
  }
  if (p.SmsStatus === 'received' && p.From && p.To && typeof p.Body === 'string') return { kind: 'inbound', id: p.MessageSid, from: p.From, to: p.To, text: p.Body }
}

const TELNYX_STATUS: Record<string, SmsStatus> = {
  queued: 'queued', sending: 'sent', sent: 'sent', delivered: 'delivered',
  delivery_failed: 'undelivered', delivery_unconfirmed: 'undelivered', sending_failed: 'failed',
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
export function telnyxEvent(body: unknown): SmsEvent | undefined {
  const data = (body as { data?: unknown } | null)?.data as { event_type?: unknown; payload?: Record<string, any> } | null | undefined
  const p = data?.payload
  if (!p || typeof p !== 'object' || !str(p.id)) return
  const to = Array.isArray(p.to) ? p.to[0] : undefined
  if (data.event_type === 'message.received') {
    const from = str(p.from?.phone_number), dest = str(to?.phone_number)
    return from && dest && typeof p.text === 'string' ? { kind: 'inbound', id: p.id, from, to: dest, text: p.text } : undefined
  }
  if (data.event_type !== 'message.sent' && data.event_type !== 'message.finalized') return
  const status = TELNYX_STATUS[str(to?.status) ?? '']
  const error = Array.isArray(p.errors) ? str(p.errors[0]?.code) : undefined
  return status && { kind: 'status', id: p.id, status, ...(error && { error }) }
}
