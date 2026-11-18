import { counted, decide, sendsTo, threadKey, type Limits, type Mode } from './decide.ts'
import { replyRequests, type GraphRequest } from './graph.ts'
import type { MetaEvent } from './meta.ts'
import { chatMessages, checkAnswer, guardMessages, guardVerdict, type ChatMessage, type Label, type Lead, type Pack } from './prompt.ts'
import type { Store } from './store.ts'

export type Settings = {
  brand: string; mode: Mode; ourAppId: string; team: string[]; limits: Limits
  maxChars: number; historyLines: number; publicCommentLine: string
  fallbackReply: string
}
export type SinkLead = { source: 'meta'; channel: MetaEvent['channel']; user: string; name?: string; adId?: string; postId?: string; label: Label; lead: Lead; at: number }
export type Deps = {
  store: Store; now: () => number; settings: Settings
  read: () => { job: string; pack: Pack }
  model: (messages: ChatMessage[], json: boolean) => Promise<string>
  send: (r: GraphRequest) => Promise<void>
  sink?: (l: SinkLead) => Promise<void>
  missed: (question: string) => void
}

const sinkable = (label: Label, lead: Lead) => label !== 'needs_info' && label !== 'not_a_fit' && !!(lead.email || lead.phone)

export async function handle(ev: MetaEvent, d: Deps): Promise<string> {
  const start = d.now(), s = d.settings, key = threadKey(ev)
  const done = (outcome: string, label?: Label) => {
    d.store.event({ at: start, key, kind: ev.kind, outcome, ...(label ? { label } : {}), ms: d.now() - start })
    return outcome
  }
  const fallback = async (why: string) => {
    if (!s.fallbackReply || !sendsTo(s.mode, ev.user, s.team)) return why
    try { for (const r of replyRequests(ev, s.fallbackReply, s.publicCommentLine)) await d.send(r) } catch { return `${why}_failed_send` }
    d.store.addLine(key, d.now(), 'bot', s.fallbackReply)
    d.store.saveThread(key, counted(t, start))
    return `${why}_fallback`
  }
  if (s.mode === 'off' && ev.kind !== 'echo') return 'off'
  if (!d.store.firstTime(ev.id, start)) return 'repeat'
  const t = d.store.thread(key)
  const decision = decide(ev, t, start, s.ourAppId, s.limits)
  if (decision.act === 'human') {
    d.store.saveThread(key, { day: t?.day ?? new Date(start).toISOString().slice(0, 10), repliesToday: t?.repliesToday ?? 0, humanAt: start })
    d.store.addLine(key, ev.at || start, 'person', '[a person answered in the Meta inbox]')
    return done('human')
  }
  if (ev.kind === 'echo') return done('our_echo')
  d.store.addLine(key, ev.at || start, 'lead', ev.text)
  if (decision.act === 'skip') return done(decision.why)

  const { job, pack } = d.read()
  const history = d.store.history(key, s.historyLines)
  let raw: string
  try { raw = await d.model(chatMessages(s.brand, job, pack, history), true) } catch { return done(await fallback('failed_model')) }
  const checked = checkAnswer(raw, pack, s.maxChars)
  if (!checked.ok) { d.store.addLine(key, d.now(), 'draft', `[held by check: ${checked.why}] ${raw.slice(0, 500)}`); return done(await fallback('held_check')) }
  const a = checked.answer
  if (a.missed) d.missed(a.missed)
  let verdict
  try { verdict = guardVerdict(await d.model(guardMessages(s.brand, job, pack, history, a.reply), false)) } catch { return done(await fallback('failed_guard'), a.label) }
  if (!verdict.send) { d.store.addLine(key, d.now(), 'draft', `[held by guard: ${verdict.reason}] ${a.reply}`); return done(await fallback('held_guard'), a.label) }

  let outcome = 'drafted'
  if (sendsTo(s.mode, ev.user, s.team)) {
    try { for (const r of replyRequests(ev, a.reply, s.publicCommentLine)) await d.send(r) } catch { return done('failed_send', a.label) }
    d.store.addLine(key, d.now(), 'bot', a.reply)
    d.store.saveThread(key, counted(t, start))
    outcome = 'sent'
  } else d.store.addLine(key, d.now(), 'draft', `[${a.label}] ${a.reply}`)

  if (d.sink && outcome === 'sent' && sinkable(a.label, a.lead) && d.store.firstTime(`sink:${key}`, start)) {
    const name = ev.kind === 'comment' ? ev.name : undefined, adId = ev.kind === 'message' ? ev.adId : undefined
    const postId = ev.kind === 'comment' ? ev.postId : undefined
    try { await d.sink({ source: 'meta', channel: ev.channel, user: ev.user, ...(name ? { name } : {}), ...(adId ? { adId } : {}), ...(postId ? { postId } : {}), label: a.label, lead: a.lead, at: start }) } catch { d.store.forget(`sink:${key}`); outcome = 'sent_sink_failed' }
  }
  return done(outcome, a.label)
}
