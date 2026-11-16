// Telemetry (ADR 0019): what one event row may tell the world. An allowlist per kind of fixed words and numbers;
// who, trace, chain, transcript and the detail text never leave. A new kind exports its name and nothing else.
import { createHash } from 'node:crypto'
import type { KageEvent } from './events.ts'

type Attrs = Record<string, string | number>
type TelemetryRecord = { at: string; name: string; attrs: Attrs }

// The word if it is one of the set, else 'other': a string that leaves is always one we wrote.
const oneOf = (w: string | undefined, set: readonly string[]) => w && set.includes(w) ? w : 'other'
const num = (s: string | undefined) => { const n = Number(s); return s != null && s !== '' && Number.isFinite(n) ? n : undefined }
const field = (detail: string, k: string) => detail.match(new RegExp(`(?:^| )${k}=([^ ]+)`))?.[1]

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']

// How the hub's run before this boot ended, from the end of its log: the lines between the last two "hub start" lines
// (hub.ts), or all of them when only one is there. killed: that run left no goodbye line, so the machine slept or
// lost power, or something killed it (kill -9, out of memory).
const BOOT_WHYS = ['update', 'settings', 'stop', 'crash', 'duplicate', 'killed', 'first']
const ENDINGS: [RegExp, string][] = [
  [/\] newer code is in place/, 'update'], [/\] settings changed and every session is quiet/, 'settings'], [/\] stopped by SIG/, 'stop'],
  [/\] crashed\b|\] the hub could not load|\] npm ci failed/, 'crash'], [/\] another hub (is running|holds the hub lock)/, 'duplicate'],
]
export function bootWhy(logTail: string) {
  const lines = logTail.split('\n').filter(l => l.trim())
  const starts = lines.flatMap((l, i) => l.includes(' hub.ts: hub start ') ? [i] : [])
  const end = starts.at(-1) === lines.length - 1 ? starts.pop()! : lines.length
  const run = lines.slice((starts.at(-1) ?? -1) + 1, end)
  for (const line of run.reverse()) for (const [re, why] of ENDINGS) if (re.test(line)) return why
  return run.length ? 'killed' : 'first'
}

// Our own log lines that mean something went wrong short of a crash, by the fixed text they start with. Only the
// code leaves: a line's other words may be someone's message or name.
const ERRORS: [RegExp, string][] = [
  [/^could not post|^(owner DM|channel post|github post|meeting post|mail reply|whatsapp send) failed/, 'post_failed'],
  [/^could not deliver to a session/, 'deliver_failed'], [/^replay failed/, 'replay_failed'], [/^session ended$/, 'session_ended'],
  [/^slack socket restart failed/, 'slack_socket'], [/^message handling failed/, 'slack_message'], [/^command( reply)? failed/, 'slack_command'],
  [/^(mail handling|mail poll) failed/, 'email'], [/^whatsapp (event|stand-in) failed/, 'whatsapp'], [/^voice request failed/, 'voice'],
  [/^meeting transcript failed/, 'meeting'], [/^github event failed/, 'github'], [/^afk \w+( \w+)? failed/, 'afk'],
  [/^channel catch-up failed/, 'catchup'], [/^kagelet measure failed/, 'kagelet'], [/^unhandled$/, 'unhandled'],
]
export const errorCode = (first: unknown) => typeof first === 'string' ? ERRORS.find(([re]) => re.test(first))?.[1] : undefined

// What one install has switched on, once a day: connectors 0 or 1, the rest counts.
const SHAPE = ['email', 'voice', 'whatsapp', 'github', 'meeting', 'browser', 'schedules', 'tripwires', 'kagelets', 'teammates']

const ATTRS: Partial<Record<KageEvent['kind'], (d: string) => Attrs>> = {
  'run.start': d => {
    const from = d.match(/^task from the (\w+)/)?.[1]
    return { trigger: oneOf(d.split(' ')[0], ['scheduled', 'task', 'next']), ...from && { from: oneOf(from, ['owner', 'teammate', 'voice']) } }
  },
  'run.end': d => {
    const cost = num(d.match(/^\$(\d+(?:\.\d+)?),/)?.[1])
    const ms = num(field(d, 'ms')), first = num(field(d, 'first_post_ms'))
    return { ...cost != null && { cost_usd: cost }, report: /no report/.test(d) ? 'no' : 'yes', ...ms != null && { ms }, ...first != null && { first_post_ms: first } }
  },
  tool: d => ({ outcome: /\brefused\b/.test(d) ? 'refused' : /\bfailed\b/.test(d) ? 'failed' : 'ok' }),
  report: d => ({ outcome: oneOf(d.split(' ')[0], ['ok', 'needs', 'failed']) }),
  tripwire: d => {
    const ms = num(field(d, 'ms'))
    const outcome = field(d, 'outcome')
    return { action: oneOf(d.split(' ')[0], ['tick', 'wake', 'ping', 'match', 'catchup', 'hook', 'decision']), ...outcome && { outcome: oneOf(outcome, ['same', 'changed', 'failed', 'refused']) }, ...ms != null && { ms } }
  },
  limit: d => {
    const wait = num(field(d, 'wait_s')), held = num(field(d, 'held'))
    return { kind: oneOf(d.split(' ')[0], ['rate_limit', 'overloaded']), window: oneOf(field(d, 'window'), WINDOWS), ...wait != null && { wait_s: wait }, ...held != null && { held } }
  },
  // The seat's plan and how full each usage window is, so cost per seat and seats per team can be measured.
  plan: d => {
    const pct = Object.fromEntries(WINDOWS.flatMap(w => { const n = num(field(d, w)); return n != null ? [[w, n]] : [] }))
    return { type: oneOf(field(d, 'type'), ['pro', 'max', 'team', 'enterprise']), ...pct, extra: field(d, 'extra') === 'on' ? 'on' : 'off' }
  },
  objective: d => ({ state: oneOf(d.split(' ')[1], ['met', 'working', 'failed']) }),
  boot: d => ({ why: oneOf(d, BOOT_WHYS) }),
  error: d => ({ code: oneOf(d, ERRORS.map(e => e[1])) }),
  shape: d => Object.fromEntries(SHAPE.flatMap(k => { const n = num(field(d, k)); return n != null ? [[k, n]] : [] })),
  crash: (d): Attrs => /^[0-9a-f]{12}$/.test(d) ? { fp: d } : {},
}

// A plan row from Claude Code's usage answer (the SDK's get_usage): undefined for an API key, which has no plan windows.
type Window = { utilization: number | null } | null | undefined
export function planDetail(u: { subscription_type: string | null; rate_limits: { extra_usage?: { is_enabled: boolean } | null } | null }) {
  if (!u.rate_limits) return undefined
  const pct = WINDOWS.flatMap(w => { const n = (u.rate_limits as Record<string, Window>)[w]?.utilization; return n != null ? [`${w}=${n}`] : [] })
  return [`type=${u.subscription_type ?? 'none'}`, ...pct, `extra=${u.rate_limits.extra_usage?.is_enabled ? 'on' : 'off'}`].join(' ')
}

export const toTelemetry = (e: KageEvent): TelemetryRecord => ({ at: e.at, name: `kage.${e.kind}`, attrs: ATTRS[e.kind]?.(e.detail) ?? {} })

// The same bug on any machine gives the same 12 hex: the error's class and its first frame inside the repo,
// with the repo path cut off. The message never counts, since it may quote what Kage was reading.
export function crashFingerprint(err: unknown, root: string): string {
  const name = err instanceof Error ? err.name : typeof err
  const stack = err instanceof Error ? err.stack ?? '' : ''
  const frames = stack.split('\n').slice(1).map(l => l.trim().match(/^at (?:(\S+) \()?(.+?):\d+:\d+\)?$/)).map(m => m ? { fn: m[1] ?? '', file: m[2] ?? '' } : undefined)
  const frame = frames.find(f => f && !f.file.startsWith('node:') && !f.file.includes('node_modules'))
  const rel = frame ? `${frame.fn} ${frame.file.replace(/^.*?\/(hub|core|runtime|connectors|cli|plugin)\//, '$1/').replace(root, '')}` : ''
  return createHash('sha256').update(`${name} ${rel}`).digest('hex').slice(0, 12)
}

// One OTLP/HTTP JSON logs body (opentelemetry-proto, logs/v1): the resource once, then one log record per event.
// The body is the event's name, so a backend that shows only the body still says what happened.
const otlpValue = (v: string | number) => typeof v === 'string' ? { stringValue: v } : Number.isInteger(v) ? { intValue: v } : { doubleValue: v }
const otlpAttrs = (a: Record<string, string | number>) => Object.entries(a).map(([key, v]) => ({ key, value: otlpValue(v) }))
export const otlpLogs = (records: TelemetryRecord[], resource: Record<string, string>) => JSON.stringify({
  resourceLogs: [{
    resource: { attributes: otlpAttrs(resource) },
    scopeLogs: [{ scope: { name: 'kage' }, logRecords: records.map(r => ({ timeUnixNano: String(Date.parse(r.at) * 1_000_000), severityText: 'INFO', body: { stringValue: r.name }, attributes: otlpAttrs(r.attrs) })) }],
  }],
})

// The Kage team's receiver. It keeps only Kage installs and an allow list of fields, so Claude Code's account fields
// never land (ADR 0019). An owner may point telemetry.endpoint elsewhere, such as their own collector.
export const TELEMETRY_URL = 'https://monitor.omnidim.io/kage'
// The one DM an owner gets before anything is sent.
export const TELEMETRY_NOTICE = 'Kage now sends anonymous counts to its makers, so we see what breaks: runs, cost, usage-limit pauses, restarts, error codes, features in use and crash fingerprints. Never message text, prompts, names or ids. See exactly what goes with `kage telemetry show`. Stop it with `kage set telemetry.on false`.'

// Where telemetry goes, or undefined for nowhere. On by default to the Kage team's receiver. The owner's off wins over
// everything: on false, KAGE_TELEMETRY=off, or DO_NOT_TRACK set to anything but 0 (consoledonottrack.com).
export function telemetryEndpoint(t: { on?: boolean | null; endpoint?: string | null } | undefined, env: Record<string, string | undefined>) {
  if (t?.on === false || env.KAGE_TELEMETRY === 'off') return undefined
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0') return undefined
  return (t?.endpoint || TELEMETRY_URL).replace(/\/+$/, '')
}

// Claude Code's own telemetry for each session (code.claude.com/docs/en/monitoring-usage): logs only, to the same
// endpoint, tagged with this install. Its prompts, replies and tool input stay redacted: every content flag is set to 0,
// over any the hub inherited. Claude Code still adds the signed-in account's email and ids (ADR 0019).
// service.name is Claude Code's own (claude-code), so the two layers stay apart on the board.
export const sessionTelemetryEnv = (endpoint: string, resource: Record<string, string>): Record<string, string> => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0',
  OTEL_RESOURCE_ATTRIBUTES: Object.entries(resource).filter(([k]) => k !== 'service.name').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(','),
})
