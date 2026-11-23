import type { WebClient } from '@slack/web-api'
import { log } from '../../runtime/log.ts'
import { claudeOnce, emptyRoom } from '../../runtime/claude-once.ts'
import { actOn, afkGuardPrompt, decideAfk, MAX_REPLIES, noteMention, noteOf, notePing, outsider, parseTriage, restoreTo, standInPrompt, standInReply, summaryOf, untilOf, type Afk, type AfkCommand, type Status, type Urgency } from '../../core/afk.ts'
import type { SlackMessage } from '../../core/slack-message.ts'
import { findSecret, guardVerdict, safeReply } from '../../core/outbound.ts'
import type { Saved } from '../../runtime/store.ts'
import type { JevAfk } from '../jev.ts'
import { ownerLines } from '../../core/messages.ts'

type Ids = { owner: string; bot: string; botDm: string; name: string; team?: string }
type Options = {
  dir: string; title: string; ownerName: string; ids: Ids; bot: WebClient; user: WebClient
  memory: string; model: string; saved: Saved
  notify: (text: string) => Promise<boolean>
  contextOf: (m: SlackMessage) => Promise<string>
  placeOf: (channel: string) => Promise<string>
  nameOf: (id?: string) => Promise<string>
  call?: (reason: string) => Promise<string>
  jev?: JevAfk
}
type State = Afk & { tz: string; ours: string; prior?: Status }
type Away = {
  o: Options; room: string; state?: State; save(): void
  busy: Set<string>; again: Map<string, { mentioned: boolean; msg: SlackMessage }>
}
type Seen = { key: string; channel: string; thread_ts?: string; mentioned: boolean; msg: SlackMessage }
type Answer = { urgency: Urgency; note: string; waits: boolean; reply: string }
type Said = { who: string; place: string; where: string; all: string; out: Answer }

const EMOJI = ':ninja:'
const GH = ['gh pr view', 'gh pr list', 'gh issue view', 'gh issue list'].map(c => `Bash(${c}:*)`).join(' ')

export function startAfk(o: Options) {
  const away: Away = { o, room: emptyRoom(o.dir), state: o.saved.load('afk') as State | undefined, busy: new Set(), again: new Map(), save: () => o.saved.save('afk', away.state) }
  if (away.state) away.state.watch ??= {}
  async function command(c: AfkCommand): Promise<string> {
    try { return c.kind === 'back' ? await afkOff(away, 'back') : await afkOn(away, c) } catch (e) { log('afk command failed', e); return `AFK command failed: ${e}` }
  }
  setInterval(() => { if (away.state && away.state.until <= Date.now()) void afkOff(away, 'time ran out').then(o.notify, e => log('afk end failed', e)) }, 30_000)
  function heard(m: SlackMessage) {
    const a = decideAfk(m, away.state, o.ids, Date.now())
    if (a.kind === 'mute' && away.state && !away.state.muted.includes(a.key)) { away.state.muted.push(a.key); away.save() }
    if (a.kind === 'triage') void triage(away, { key: a.key, channel: a.channel, thread_ts: a.thread_ts, mentioned: a.mentioned, msg: m })
  }
  return { heard, command }
}

function when(t: number, tz: string) {
  const day = (x: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short' }).format(x)
  const f = (x: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...x }).format(t)
  return `${day(t) === day(Date.now()) ? '' : `${f({ weekday: 'short' })} `}${f({ hour: 'numeric', minute: '2-digit' }).toLowerCase()}`
}

async function setStatus(o: Options, s: Status) {
  await o.user.users.profile.set({ profile: JSON.stringify(s) } as never)
}

async function afkOn(away: Away, c: Extract<AfkCommand, { kind: 'afk' }>): Promise<string> {
  const { o, state } = away
  const u = await o.user.users.info({ user: o.ids.owner }).catch(() => null)
  const tz = (u?.user as { tz?: string } | undefined)?.tz || 'UTC'
  const now = Date.now()
  const until = untilOf(c, now, tz)
  const ours = `Away until ${when(until, tz)}. ${o.title} is covering`
  const prior = state?.prior ?? (await o.user.users.profile.get({}).catch(() => null))?.profile as Status | undefined
  away.state = { since: state?.since ?? now, until, note: c.note, tz, ours, prior, replies: state?.replies ?? {}, muted: state?.muted ?? [], watch: state?.watch ?? {}, pings: state?.pings ?? [], lastCall: state?.lastCall }
  away.save()
  const set = await setStatus(o, { status_text: ours, status_emoji: EMOJI, status_expiration: Math.floor(until / 1000) })
    .then(() => '', (e: any) => ` Could not set your status (${e?.data?.error ?? e}). Add users.profile:read and users.profile:write under User Token Scopes on the app's OAuth page, reinstall it, then try again.`)
  log('afk on until', new Date(until).toISOString())
  return `AFK on until ${when(until, tz)}. I watch threads that mention you and stay quiet unless you're mentioned again or it's urgent. A P0 gets a phone call${o.call ? '' : ' (no connectors.call.command set, so a DM instead)'}.${set}`
}

async function afkOff(away: Away, why: string): Promise<string> {
  const s = away.state
  if (!s) return 'You were not away.'
  away.state = undefined
  away.save()
  const now = (await away.o.user.users.profile.get({}).catch(() => null))?.profile as Status | undefined
  const to = now && restoreTo(now, s.ours, s.prior, Date.now())
  if (to) await setStatus(away.o, to).catch(e => log('afk status restore failed', e?.data?.error ?? e))
  log('afk off:', why)
  return summaryOf(s.pings)
}

async function post(o: Options, channel: string, thread_ts: string | undefined, text: string) {
  const body = safeReply(text)
  try { await o.bot.chat.postMessage({ channel, thread_ts, text: body, unfurl_links: false }) } catch (e: any) {
    if (!['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) throw e
    await o.user.chat.postMessage({ channel, thread_ts, text: `*${o.title}:* ${body}`, unfurl_links: false })
  }
}

async function triage(away: Away, p: Seen) {
  const { busy, again } = away
  if (busy.has(p.key)) {
    const prev = again.get(p.key)
    return void again.set(p.key, { mentioned: p.mentioned || !!prev?.mentioned, msg: p.msg })
  }
  busy.add(p.key)
  try { await judge(away, p) } catch (e) { log('afk triage failed', p.key, e) } finally { busy.delete(p.key) }
  const next = again.get(p.key)
  if (next) { again.delete(p.key); void triage(away, { ...p, mentioned: next.mentioned, msg: next.msg }) }
}

async function judge(away: Away, p: Seen) {
  const before = away.state
  if (!before) return
  const { o } = away
  const { key, channel, thread_ts, msg } = p
  const w = before.watch[key] ??= { channel, thread_ts, mentions: 0 }
  const repeat = p.mentioned && noteMention(w, Date.now())
  away.save()
  const [u, c] = await Promise.all([o.user.users.info({ user: msg.user! }).catch(() => null), o.user.conversations.info({ channel }).catch(() => null)])
  const outside = outsider(u?.user, c?.channel, o.ids.team ?? '')
  const [convo, place, who, link] = await Promise.all([
    o.contextOf(msg), o.placeOf(channel), o.nameOf(msg.user),
    o.user.chat.getPermalink({ channel, message_ts: thread_ts ?? msg.ts }).then(r => r.permalink ?? '', () => ''),
  ])
  const all = `${convo}\n> [${who}, the newest message] ${(msg.text ?? '').replace(/\n/g, ' ')}`
  const out = await standIn(o, before, { who, place, all, text: msg.text ?? '' })
  if (!out) return void log('afk: stand-in gave no usable answer in', place)
  const s = away.state
  if (!s || s.since !== before.since || s.until <= Date.now() || s.muted.includes(key)) return
  const act = actOn(out.urgency, repeat, key, w, s, Date.now(), outside)
  const where = link ? `<${link}|${place}>` : place
  notePing(s, { key, when: Date.now(), who, place, link, note: out.note, waits: out.waits, urgency: out.urgency })
  if (act.call) { w.called = true; s.lastCall = Date.now() }
  away.save()
  log('afk triage', key, out.urgency, act)
  if (act.call) phone(o, who, place, where, out.note)
  if (!act.post || !out.reply) return
  await replyFor(away, s, p, { who, place, where, all, out })
}

async function standIn(o: Options, before: State, x: { who: string; place: string; all: string; text: string }): Promise<Answer | null> {
  const until = when(before.until, before.tz)
  const j = await o.jev?.({ owner: o.ownerName, place: x.place, from: x.who, convo: x.all })
  const sp = standInPrompt({ owner: o.ownerName, title: o.title, until, note: before.note, place: x.place, from: x.who, convo: x.all })
  const claudeOut = !j || j.lookup ? await claudeOnce({ model: o.model, system: sp.system, prompt: sp.prompt, cwd: o.memory, tools: 'Read,Grep,Glob,Bash', allowed: GH }).then(parseTriage, e => { if (!j) throw e; return null }) : null
  return j
    ? { urgency: j.urgency, waits: j.waits, note: noteOf(x.who, x.text), reply: claudeOut?.reply || standInReply(j.urgency, { owner: o.ownerName, until, title: o.title }) }
    : claudeOut
}

function phone(o: Options, who: string, place: string, where: string, note: string) {
  void (o.call ? o.call(`${who} in ${place}: ${note}`).catch(e => String(e)) : Promise.resolve('no connectors.call.command'))
    .then(no => o.notify(ownerLines.afkP0(who, where, note, no)))
}

async function replyFor(away: Away, s: State, p: Seen, x: Said) {
  const { o } = away
  const g = afkGuardPrompt(x.all, x.out.reply)
  const why = findSecret(x.out.reply) ? 'looks like a key or secret' : (v => v.send ? '' : v.reason)(guardVerdict(await claudeOnce({ model: o.model, system: g.system, prompt: g.prompt, cwd: away.room, tools: '' })))
  const t = away.state
  if (!t || t.since !== s.since || t.muted.includes(p.key) || (t.replies[p.key] ?? 0) >= MAX_REPLIES) return
  if (why) return void await o.notify(ownerLines.afkHeld(x.who, x.where, why, x.out.reply))
  t.replies[p.key] = (t.replies[p.key] ?? 0) + 1
  away.save()
  await post(o, p.channel, p.thread_ts, x.out.reply)
  await o.notify(ownerLines.afkReplied(x.out.urgency, x.who, x.where, x.out.note, x.out.reply))
}
