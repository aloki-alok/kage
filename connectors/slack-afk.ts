// AFK mode I/O, Slack only (rules in core/afk.ts). The owner's session calls away or back (the
// session tools), and Kage sets their status. While they are away, a stand-in watches the threads
// where colleagues mention them or DM them, posts only when actOn says so, and phones the owner for
// a P0. It never starts a session: tags of Kage still go through the gate as before.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import { log } from '../config.ts'
import { actOn, afkGuardPrompt, decideAfk, MAX_REPLIES, notePing, outsider, parseTriage, restoreTo, standInPrompt, summaryOf, untilOf, type Afk, type AfkCommand, type Status } from '../core/afk.ts'
import type { SlackMessage } from '../core/slack-message.ts'
import { findSecret, safeReply } from '../core/outbound.ts'
import { guardVerdict } from './whatsapp.ts'

type Ids = { owner: string; bot: string; botDm: string; name: string; team?: string }
const EMOJI = ':ninja:'
// Read-only GitHub: in -p mode with no settings, a Bash call outside these rules is denied (tested
// 2026-11-04: gh pr view ran, curl was refused).
const GH = ['gh pr view', 'gh pr list', 'gh issue view', 'gh issue list'].map(c => `Bash(${c}:*)`).join(' ')

export function startAfk(o: {
  dir: string; title: string; ownerName: string; ids: Ids; bot: WebClient; user: WebClient
  memory: string; model: string
  notify: (text: string) => Promise<boolean>
  contextOf: (m: SlackMessage) => Promise<string>
  placeOf: (channel: string) => Promise<string>
  nameOf: (id?: string) => Promise<string>
  // Phones the owner (KAGE_CALL_COMMAND); resolves '' once the call is placed, else why not.
  call?: (reason: string) => Promise<string>
}) {
  const FILE = `${o.dir}/afk.json`
  // An empty folder for the guard, so its Claude finds no CLAUDE.md or project memory.
  const ROOM = `${o.dir}/standin`
  mkdirSync(ROOM, { recursive: true, mode: 0o700 })
  // Kept on disk so a hub restart stays away; prior is the owner's status before Kage set its own.
  let state: (Afk & { tz: string; ours: string; prior?: Status }) | undefined
  try { state = JSON.parse(readFileSync(FILE, 'utf8')) } catch {}
  if (state) state.watch ??= {}   // a file from before threads were watched
  const save = () => state ? writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 }) : rmSync(FILE, { force: true })

  // "6:00 pm", or "Thu 9:00 am" when it is not today in the owner's zone.
  const when = (t: number, tz: string) => {
    const day = (x: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short' }).format(x)
    const f = (x: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...x }).format(t)
    return `${day(t) === day(Date.now()) ? '' : `${f({ weekday: 'short' })} `}${f({ hour: 'numeric', minute: '2-digit' }).toLowerCase()}`
  }

  async function setStatus(s: Status) {
    await o.user.users.profile.set({ profile: JSON.stringify(s) } as never)
  }

  // Resolves the line to tell the owner; the owner's session posts it.
  async function on(c: Extract<AfkCommand, { kind: 'afk' }>): Promise<string> {
    const u = await o.user.users.info({ user: o.ids.owner }).catch(() => null)
    const tz = (u?.user as { tz?: string } | undefined)?.tz || 'UTC'
    const now = Date.now()
    const until = untilOf(c, now, tz)
    const ours = `Away until ${when(until, tz)}. ${o.title} is covering`
    // A second away moves the end time and keeps what the first one saw.
    const prior = state?.prior ?? (await o.user.users.profile.get({}).catch(() => null))?.profile as Status | undefined
    state = { since: state?.since ?? now, until, note: c.note, tz, ours, prior, replies: state?.replies ?? {}, muted: state?.muted ?? [], watch: state?.watch ?? {}, pings: state?.pings ?? [], lastCall: state?.lastCall }
    save()
    const set = await setStatus({ status_text: ours, status_emoji: EMOJI, status_expiration: Math.floor(until / 1000) })
      .then(() => '', (e: any) => ` Could not set your status (${e?.data?.error ?? e}). Add users.profile:read and users.profile:write under User Token Scopes on the app's OAuth page, reinstall it, then try again.`)
    log('afk on until', new Date(until).toISOString())
    return `AFK on until ${when(until, tz)}. I watch threads that mention you and stay quiet unless you're mentioned again or it's urgent. A P0 gets a phone call${o.call ? '' : ' (no KAGE_CALL_COMMAND set, so a DM instead)'}.${set}`
  }

  // Resolves the summary for the owner.
  async function off(why: string): Promise<string> {
    const s = state
    if (!s) return 'You were not away.'
    state = undefined
    save()
    // A failed read leaves the status alone: it may be one the owner set since.
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

  // No MCP, no settings (so no CLAUDE.md, hooks or allow rules), nothing saved. Reads stay in cwd.
  function claude(system: string, prompt: string, cwd: string, tools: string, allowed = ''): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn('claude', ['-p', '--tools', tools, ...(allowed ? ['--allowedTools', allowed] : []), '--strict-mcp-config', '--setting-sources', '',
        '--no-session-persistence', '--model', o.model, '--system-prompt', system], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', c => { out += c })
      const timer = setTimeout(() => p.kill(), 120_000)
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}`)) })
      p.stdin.end(prompt)
    })
  }

  // Kage posts as the bot where it is a member, else with the owner's token, labelled.
  async function post(channel: string, thread_ts: string | undefined, text: string) {
    const body = safeReply(text)
    try { await o.bot.chat.postMessage({ channel, thread_ts, text: body, unfurl_links: false }) } catch (e: any) {
      if (!['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) throw e
      // The same label as session replies, so gate.ts quoteMessage reads it back as Kage.
      await o.user.chat.postMessage({ channel, thread_ts, text: `*${o.title}:* ${body}`, unfurl_links: false })
    }
  }

  // One triage at a time per thread. A message that lands meanwhile asks for one more run, which
  // reads the thread again, so the last word in a burst is always judged.
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
    if (mentioned) w.mentions++
    save()
    const [u, c] = await Promise.all([o.user.users.info({ user: msg.user! }).catch(() => null), o.user.conversations.info({ channel }).catch(() => null)])
    const outside = outsider(u?.user, c?.channel, o.ids.team ?? '')
    const [convo, place, who, link] = await Promise.all([
      o.contextOf(msg), o.placeOf(channel), o.nameOf(msg.user),
      o.user.chat.getPermalink({ channel, message_ts: thread_ts ?? msg.ts }).then(r => r.permalink ?? '', () => ''),
    ])
    const all = `${convo}\n> [${who}, the newest message] ${(msg.text ?? '').replace(/\n/g, ' ')}`
    const { system, prompt } = standInPrompt({ owner: o.ownerName, title: o.title, until: when(before.until, before.tz), note: before.note, place, from: who, convo: all })
    const out = parseTriage(await claude(system, prompt, o.memory, 'Read,Grep,Glob,Bash', GH))
    if (!out) return void log('afk: stand-in gave no usable answer in', place)
    // Checked again after the thinking: the owner may be back, or typing here.
    const s = state
    if (!s || s !== before || s.until <= Date.now() || s.muted.includes(key)) return
    const act = actOn(out.urgency, key, w, s, Date.now(), outside)
    const where = link ? `<${link}|${place}>` : place
    notePing(s, { key, when: Date.now(), who, place, link, note: out.note, waits: out.waits, urgency: out.urgency })
    if (act.call) { w.called = true; s.lastCall = Date.now() }
    save()
    log('afk triage', key, out.urgency, act)
    if (act.call) {
      const no = o.call ? await o.call(`${who} in ${place}: ${out.note}`).catch(e => String(e)) : 'no KAGE_CALL_COMMAND'
      await o.notify(`:rotating_light: P0 from ${who} in ${where}: ${out.note}\n${no ? `Could not phone you (${no}).` : 'Calling you now.'}`)
    }
    if (!act.post || !out.reply) return
    const g = afkGuardPrompt(all, out.reply)
    const why = findSecret(out.reply) ? 'looks like a key or secret' : (v => v.send ? '' : v.reason)(guardVerdict(await claude(g.system, g.prompt, ROOM, '')))
    const t = state
    if (!t || t !== s || t.muted.includes(key) || (t.replies[key] ?? 0) >= MAX_REPLIES) return
    if (why) return void await o.notify(`Held a reply to ${who} in ${where} (${why}). Post it yourself if it is fine:\n${out.reply}`)
    t.replies[key] = (t.replies[key] ?? 0) + 1
    save()
    await post(channel, thread_ts, out.reply)
    await o.notify(`${out.urgency === 'p0' || out.urgency === 'high' ? ':exclamation: ' : ''}Replied to ${who} in ${where}: ${out.note}\n> ${out.reply.replace(/\n/g, '\n> ')}`)
  }

  function heard(m: SlackMessage) {
    const a = decideAfk(m, state, o.ids, Date.now())
    if (a.kind === 'mute' && state && !state.muted.includes(a.key)) { state.muted.push(a.key); save() }
    if (a.kind === 'triage') void triage(a.key, a.channel, a.thread_ts, a.mentioned, m)
  }

  return { heard, command }
}
