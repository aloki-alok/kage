// Kage's log line, and the logger the Slack clients get.
import { LogLevel } from '@slack/web-api'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { repeats } from '../core/log-repeats.ts'

// In a session, stdout is the MCP pipe: every log line goes to stderr. The time lets one line be matched to another.
let tap: ((first: unknown) => void) | undefined
// The hub's one listener on its own log lines: telemetry counts our fixed error lines (core/telemetry.ts errorCode).
export const tapLog = (f: (first: unknown) => void) => { tap = f }
export const log = (...a: unknown[]) => { console.error(new Date().toISOString(), '[kage]', ...a); tap?.(a[0]) }
// An address, phone number or chat id as the log may hold it (ADR 0010): the same 8 characters each time, so lines still match up.
export const logRef = (s: string) => createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 8)
// A session key for a log line: a WhatsApp key holds a phone number, so its chat becomes a logRef.
export const logKey = (key: string) => key.replace(/wa:(.+)$/, (_, chat: string) => `wa:${logRef(chat)}`)
// Only the Slack library's warnings collapse (a dropped network repeats one every few seconds); Kage's own lines,
// crashes included, always print.
const once = repeats(10 * 60_000)
// The hub's longest stall since the last Slack warning. A missed pong next to a long stall means the hub froze, not the network.
const stall = monitorEventLoopDelay({ resolution: 50 })
stall.enable()
const slackWarn = (...a: unknown[]) => {
  const ms = Math.round(stall.max / 1e6)
  stall.reset()
  for (const l of once(a.map(x => (typeof x === 'string' ? x : inspect(x))).join(' '), Date.now())) log('warn', l, `(hub stalled up to ${ms} ms since the last Slack warning)`)
}
let level = LogLevel.WARN
export const logger = {
  debug: () => {},
  info: () => {},
  warn: slackWarn,
  error: (...a: unknown[]) => log('error', ...a),
  setLevel: (l: LogLevel) => { level = l },
  getLevel: () => level,
  setName: () => {},
}
