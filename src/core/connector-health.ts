import { oneLine } from './text.ts'

const NAMES = ['email', 'whatsapp', 'voice', 'meetings', 'github', 'sms', 'jev', 'slack'] as const
type ConnectorName = (typeof NAMES)[number]
const WHO: [RegExp, ConnectorName][] = [[/^slack\b/, 'slack'], [/^(mail|email)\b/, 'email'], [/^whatsapp\b/, 'whatsapp'], [/^voice\b/, 'voice'], [/^(meeting|meetings|meetbot exited)\b/, 'meetings'], [/^github\b/, 'github'], [/^sms\b/, 'sms'], [/^jev\b/, 'jev']]
const FAILS = /\b(failed|could not|bridge down|bad event|exited)\b/
const START = /^\w+ on:|^jev checks /
const JEV_LINE = /^triage [^:]+(?::[^:]+)?: \w+: (.*)$|^(?:answering|dropped) \S+ from app \S+: (.*)$/, JEV_SKIP = /^(no jev call|conversation unavailable|jev does not check)/, JEV_FAIL = /^jev (failed|answered HTTP)|^jev: /
const OUTGOING = /^(mail (sent|reply)|whatsapp (stand-in|card|send held)|sms (reply|report)|(github|meeting) post failed)\b/
const SLACK_UP = /^slack (http on|socket connected)\b/
const TRANSPORT = { http: 'HTTP', socket: 'Socket Mode' }
const HOUR = 3_600_000

const ago = (ms: number) => ms < 60_000 ? 'just now' : ms < HOUR ? `${Math.floor(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.floor(ms / HOUR)}h ago` : `${Math.floor(ms / 86_400_000)}d ago`
const errorText = (rest: unknown[]) => rest.map(x => x instanceof Error ? x.message : typeof x === 'string' ? x : '').filter(Boolean).join(' ')

export function connectorHealth(startedAt: number) {
  const on = new Set<ConnectorName>(), down = new Set<ConnectorName>()
  const heard = new Map<ConnectorName, number>()
  const fails = new Map<ConnectorName, { at: number; text: string }[]>()
  let jev = { day: '', calls: 0, failed: 0 }
  let transport: keyof typeof TRANSPORT | undefined
  const dayOf = (t: number) => new Date(t).toDateString()

  function see(args: unknown[], now: number) {
    const [first, ...rest] = args
    if (typeof first !== 'string') return
    const m = JEV_LINE.exec(first), jevWhy = m?.[1] ?? m?.[2]
    if (jevWhy !== undefined) {
      if (JEV_SKIP.test(jevWhy)) return
      if (jev.day !== dayOf(now)) jev = { day: dayOf(now), calls: 0, failed: 0 }
      jev.calls++
      if (JEV_FAIL.test(jevWhy)) jev.failed++
      return
    }
    const up = SLACK_UP.exec(first)
    if (up) { on.add('slack'); transport = up[1] === 'http on' ? 'http' : 'socket'; return }
    const who = WHO.find(([re]) => re.test(first))?.[1]
    if (!who) return
    if (START.test(first)) { on.add(who); return }
    if (/could not listen/.test(first)) on.delete(who)
    if (/bridge down/.test(first)) down.add(who)
    if (/bridge back/.test(first)) { down.delete(who); return }
    if (OUTGOING.test(first)) return
    if (!FAILS.test(first)) { heard.set(who, now); return }
    const why = oneLine(`${first}${rest.length ? `: ${errorText(rest)}` : ''}`).slice(0, 120)
    fails.set(who, [...(fails.get(who) ?? []).filter(f => now - f.at < HOUR), { at: now, text: why }])
  }

  function line(name: ConnectorName, now: number): string {
    const head = `${name.padEnd(9)} ${on.has(name) ? 'on' : 'off'}`
    if (!on.has(name)) return head
    if (name === 'jev') {
      const today = jev.day === dayOf(now) ? jev : { calls: 0, failed: 0 }
      return `${head} · ${today.calls} call${today.calls === 1 ? '' : 's'} today${today.failed ? `, ${today.failed} failed` : ''}`
    }
    const at = heard.get(name), recent = (fails.get(name) ?? []).filter(f => now - f.at < HOUR)
    const last = at === undefined ? `nothing heard since the hub started ${ago(now - startedAt)}` : `last heard ${ago(now - at)}`
    return `${head} · ${name === 'slack' && transport ? `over ${TRANSPORT[transport]} · ` : ''}${down.has(name) ? 'bridge down · ' : ''}${last}${recent.length ? ` · failed ${recent.length}x in 1h: ${recent.at(-1)!.text}` : ''}`
  }

  function row(name: ConnectorName, now: number) {
    if (name === 'jev') { const today = jev.day === dayOf(now) ? jev : { calls: 0, failed: 0 }; return { name, on: on.has(name), callsToday: today.calls, failedToday: today.failed } }
    const recent = (fails.get(name) ?? []).filter(f => now - f.at < HOUR), at = heard.get(name)
    return { name, on: on.has(name), ...name === 'slack' && { transport: transport ?? null }, bridgeDown: down.has(name), lastHeardAt: at === undefined ? null : new Date(at).toISOString(), failedLastHour: recent.length, lastFailure: recent.at(-1)?.text ?? null }
  }

  return {
    see,
    lines: (now: number) => NAMES.map(n => line(n, now)),
    rows: (now: number) => NAMES.map(n => row(n, now)),
  }
}
