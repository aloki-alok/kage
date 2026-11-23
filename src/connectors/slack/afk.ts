import type { WebClient } from '@slack/web-api'
import { log } from '../../runtime/log.ts'
import { claudeOnce, emptyRoom } from '../../runtime/claude-once.ts'
import { actOn, afkGuardPrompt, decideAfk, MAX_REPLIES, noteMention, noteOf, notePing, outsider, parseTriage, restoreTo, standInPrompt, standInReply, summaryOf, untilOf, type Afk, type AfkCommand, type Status } from '../../core/afk.ts'
import type { SlackMessage } from '../../core/slack-message.ts'
import { findSecret, guardVerdict, safeReply } from '../../core/outbound.ts'
import type { Saved } from '../../runtime/store.ts'
import type { JevAfk } from '../jev.ts'
import { ownerLines } from '../../core/messages.ts'

type Ids = { owner: string; bot: string; botDm: string; name: string; team?: string }
const EMOJI = ':ninja:'
const GH = ['gh pr view', 'gh pr list', 'gh issue view', 'gh issue list'].map(c => `Bash(${c}:*)`).join(' ')

export function startAfk(o: {
  dir: string; title: string; ownerName: string; ids: Ids; bot: WebClient; user: WebClient
  memory: string; model: string; saved: Saved
  notify: (text: string) => Promise<boolean>
  contextOf: (m: SlackMessage) => Promise<string>
  placeOf: (channel: string) => Promise<string>
  nameOf: (id?: string) => Promise<string>
  call?: (reason: string) => Promise<string>
  jev?: JevAfk
}) {
  const ROOM = emptyRoom(o.dir)
  let state = o.saved.load('afk') as (Afk & { tz: string; ours: string; prior?: Status }) | undefined
  if (state) state.watch ??= {}
  const save = () => o.saved.save('afk', state)

  const when = (t: number, tz: string) => {
    const day = (x: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short' }).format(x)
    const f = (x: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...x }).format(t)
    return `${day(t) === day(Date.now()) ? '' : `${f({ weekday: 'short' })} `}${f({ hour: 'numeric', minute: '2-digit' }).toLowerCase()}`
  }

  async function setStatus(s: Status) {
    await o.user.users.profile.set({ profile: JSON.stringify(s) } as never)
  }

  async function on(c: Extract<AfkCommand, { kind: 'afk' }>): Promise<string> {
    const u = await o.user.users.info({ user: o.ids.owner }).catch(() => null)
    const tz = (u?.user as { tz?: string } | undefined)?.tz || 'UTC'
    const now = Date.now()
    const until = untilOf(c, now, tz)
    const ours = `Away until ${when(until, tz)}. ${o.title} is covering`
    const prior = state?.prior ?? (await o.user.users.profile.get({}).catch(() => null))?.profile as Status | undefined
    state = { since: state?.since ?? now, until, note: c.note, tz, ours, prior, replies: state?.replies ?? {}, muted: state?.muted ?? [], watch: state?.watch ?? {}, pings: state?.pings ?? [], lastCall: state?.lastCall }
    save()
    const set = await setStatus({ status_text: ours, status_emoji: EMOJI, status_expiration: Math.floor(until / 1000) })
      .then(() => '', (e: any) => ` Could not set your status (${e?.data?.error ?? e}). Add users.profile:read and users.profile:write under User Token Scopes on the app's OAuth page, reinstall it, then try again.`)
    log('afk on until', new Date(until).toISOString())
    return `AFK on until ${when(until, tz)}. I watch threads that mention you and stay quiet unless you're mentioned again or it's urgent. A P0 gets a phone call${o.call ? '' : ' (no connectors.call.command set, so a DM instead)'}.${set}`
  }

  async function off(why: string): Promise<string> {
    const s = state
    if (!s) return 'You were not away.'
    state = undefined
    save()
    const now = (await o.user.users.profile.get({}).catch(() => null))?.profile as Status | undefined
    const to = now && restoreTo(now, s.ours, s.prior, Date.now())
    if (to) await setStatus(to).catch(e => log('afk status restore failed', e?.data?.error ?? e))
    log('afk off:', why)
    return summaryOf(s.pings)
  }

  async function command(c: AfkCommand): Promise<string> {
    try { return c.kind === 'back' ? await off('back') : await on(c) } catch (e) { log('afk command failed', e); return `AFK command failed: ${e}` }
  }
  setInterval(() => { if (state && state.until <= Date.now()) void off('time ran out').then(o.notify, e => log('afk end failed', e)) }, 30_000)

  async function post(channel: string, thread_ts: string | undefined, text: string) {
    const body = safeReply(text)
    try { await o.bot.chat.postMessage({ channel, thread_ts, text: body, unfurl_links: false }) } catch (e: any) {
      if (!['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) throw e
      await o.user.chat.postMessage({ channel, thread_ts, text: `*${o.title}:* ${body}`, unfurl_links: false })
    }
  }

  const busy = new Set<string>()
  const again = new Map<string, { mentioned: boolean; msg: SlackMessage }>()
  async function triage(key: string, channel: string, thread_ts: string | undefined, mentioned: boolean, msg: SlackMessage) {
    if (busy.has(key)) {
      const prev = again.get(key)
      return void again.set(key, { mentioned: mentioned || !!prev?.mentioned, msg })
    }
    busy.add(key)
    try { await judge(key, channel, thread_ts, mentioned, msg) } catch (e) { log('afk triage failed', key, e) } finally { busy.delete(key) }
    const next = again.get(key)
    if (next) { again.delete(key); void triage(key, channel, thread_ts, next.mentioned, next.msg) }
  }

  async function judge(key: string, channel: string, thread_ts: string | undefined, mentioned: boolean, msg: SlackMessage) {
    const before = state
    if (!before) return
    const w = before.watch[key] ??= { channel, thread_ts, mentions: 0 }
    const repeat = mentioned && noteMention(w, Date.now())
    save()
    const [u, c] = await Promise.all([o.user.users.info({ user: msg.user! }).catch(() => null), o.user.conversations.info({ channel }).catch(() => null)])
    const outside = outsider(u?.user, c?.channel, o.ids.team ?? '')
    const [convo, place, who, link] = await Promise.all([
      o.contextOf(msg), o.placeOf(channel), o.nameOf(msg.user),
      o.user.chat.getPermalink({ channel, message_ts: thread_ts ?? msg.ts }).then(r => r.permalink ?? '', () => ''),
    ])
    const all = `${convo}\n> [${who}, the newest message] ${(msg.text ?? '').replace(/\n/g, ' ')}`
    const until = when(before.until, before.tz)
    const j = await o.jev?.({ owner: o.ownerName, place, from: who, convo: all })
    const sp = standInPrompt({ owner: o.ownerName, title: o.title, until, note: before.note, place, from: who, convo: all })
    const claudeOut = !j || j.lookup ? await claudeOnce({ model: o.model, system: sp.system, prompt: sp.prompt, cwd: o.memory, tools: 'Read,Grep,Glob,Bash', allowed: GH }).then(parseTriage, e => { if (!j) throw e; return null }) : null
    const out = j
      ? { urgency: j.urgency, waits: j.waits, note: noteOf(who, msg.text ?? ''), reply: claudeOut?.reply || standInReply(j.urgency, { owner: o.ownerName, until, title: o.title }) }
      : claudeOut
    if (!out) return void log('afk: stand-in gave no usable answer in', place)
    const s = state
    if (!s || s.since !== before.since || s.until <= Date.now() || s.muted.includes(key)) return
    const act = actOn(out.urgency, repeat, key, w, s, Date.now(), outside)
    const where = link ? `<${link}|${place}>` : place
    notePing(s, { key, when: Date.now(), who, place, link, note: out.note, waits: out.waits, urgency: out.urgency })
    if (act.call) { w.called = true; s.lastCall = Date.now() }
    save()
    log('afk triage', key, out.urgency, act)
    if (act.call) void (o.call ? o.call(`${who} in ${place}: ${out.note}`).catch(e => String(e)) : Promise.resolve('no connectors.call.command'))
      .then(no => o.notify(ownerLines.afkP0(who, where, out.note, no)))
    if (!act.post || !out.reply) return
    const g = afkGuardPrompt(all, out.reply)
    const why = findSecret(out.reply) ? 'looks like a key or secret' : (v => v.send ? '' : v.reason)(guardVerdict(await claudeOnce({ model: o.model, system: g.system, prompt: g.prompt, cwd: ROOM, tools: '' })))
    const t = state
    if (!t || t.since !== s.since || t.muted.includes(key) || (t.replies[key] ?? 0) >= MAX_REPLIES) return
    if (why) return void await o.notify(ownerLines.afkHeld(who, where, why, out.reply))
    t.replies[key] = (t.replies[key] ?? 0) + 1
    save()
    await post(channel, thread_ts, out.reply)
    await o.notify(ownerLines.afkReplied(out.urgency, who, where, out.note, out.reply))
  }

  function heard(m: SlackMessage) {
    const a = decideAfk(m, state, o.ids, Date.now())
    if (a.kind === 'mute' && state && !state.muted.includes(a.key)) { state.muted.push(a.key); save() }
    if (a.kind === 'triage') void triage(a.key, a.channel, a.thread_ts, a.mentioned, m)
  }

  return { heard, command }
}
