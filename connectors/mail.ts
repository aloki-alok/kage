// Email as a way to tag Kage: who may, what the ask is, and how a reply goes back.
// Pure functions; the router does the AWS calls.
import { sessionKey } from '../core/conversations.ts'

export type InboundMail = {
  // SES receipt verdicts: PASS, FAIL, GRAY or PROCESSING_FAILED.
  verdicts: { spam: string; virus: string; dmarc: string }
  // Our own DKIM check of the raw message, one entry per signature.
  dkim: { domain: string; selector: string; pass: boolean }[]
  from: string
  to: string[]
  cc: string[]
  messageId: string
  inReplyTo?: string
  references: string[]
  subject: string
  text: string
}

export type MailConfig = {
  self: string        // Kage's own address
  name: string        // what people type after @
  owner: string
  teammates: string[]
  domains: string[]   // replies go only to addresses on these domains
  selector?: string   // the DKIM selector of the senders' mail provider
}

export type MailTask = { key: string; sender: 'owner' | 'teammate'; ask: string; quoted: string } | { drop: string }

const lower = (a: string) => a.trim().toLowerCase()
const domainOf = (a: string) => lower(a).split('@')[1] ?? ''

// The text a person wrote in this message: everything before the quote header, minus > lines.
// Gmail wraps "On <date> <name> <addr> wrote:" across lines, so the header may span two.
export function newPart(text: string): string {
  const cut = text.search(/^On [^\n]*(\n[^\n]*)?wrote:\s*$/m)
  return (cut >= 0 ? text.slice(0, cut) : text)
    .split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim()
}

export function mailTask(m: InboundMail, c: MailConfig): MailTask {
  for (const v of ['spam', 'virus', 'dmarc'] as const) {
    if (m.verdicts[v] !== 'PASS') return { drop: `${v} verdict ${m.verdicts[v]}` }
  }
  const from = lower(m.from)
  const sender = from === lower(c.owner) ? 'owner' : c.teammates.map(lower).includes(from) ? 'teammate' : undefined
  if (!sender) return { drop: `${from} is not allowed` }
  // DMARC passes on any aligned signature, and our own SES can sign as our domain. Only the
  // mail provider's signature proves the person sent it from their mailbox.
  const selector = c.selector ?? 'google'
  if (!m.dkim.some(s => s.pass && lower(s.domain) === domainOf(from) && s.selector === selector)) {
    return { drop: `no valid ${selector} signature for ${domainOf(from)}` }
  }
  const ask = newPart(m.text)
  if (!new RegExp(`@${c.name}\\b`, 'i').test(ask)) return { drop: 'not tagged in the new text' }
  const root = m.references[0] ?? m.inReplyTo ?? m.messageId
  const quoted = m.text.slice(m.text.indexOf(ask) + ask.length).trim()
  return { key: sessionKey({ connector: 'email', chat: root, kind: 'mail' }), sender, ask, quoted }
}

// Reply-all, kept to our own domains: the sender in To, other participants in Cc.
export function replyTargets(m: InboundMail, c: MailConfig): { to: string[]; cc: string[] } {
  const ours = (a: string) => c.domains.includes(domainOf(a)) && lower(a) !== lower(c.self)
  const from = lower(m.from)
  const cc = [...new Set([...m.to, ...m.cc].map(lower))].filter(a => a !== from && ours(a))
  return { to: ours(from) ? [from] : [], cc }
}

const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim()

export function composeReply(r: {
  from: string; to: string[]; cc: string[]; subject: string; inReplyTo: string; references: string[]; text: string
}): string {
  const subject = clean(r.subject)
  const headers = [
    `From: ${clean(r.from)}`,
    `To: ${r.to.map(clean).join(', ')}`,
    r.cc.length ? `Cc: ${r.cc.map(clean).join(', ')}` : '',
    `Subject: ${/^re:/i.test(subject) ? subject : `Re: ${subject}`}`,
    `In-Reply-To: ${clean(r.inReplyTo)}`,
    r.references.length ? `References: ${r.references.map(clean).join(' ')}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean)
  const body = Buffer.from(r.text).toString('base64').replace(/.{76}/g, '$&\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

// The instruction line Claude reads. Email gets teammate limits even from the owner's address,
// so anything that needs the owner's yes still waits for it in Slack. One line, no channel tag.
export function emailTaskLine(from: string, sender: 'owner' | 'teammate', ask: string): string {
  const t = ask.replace(/<\/?channel/gi, m => m.replace('<', '&lt;')).replace(/\s+/g, ' ').trim()
  return `Email task (${from}, ${sender}, by email: teammate limits apply): ${t}`
}
