// Kage's log line, and the logger the Slack clients get.
import { LogLevel } from '@slack/web-api'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { repeats } from '../core/log-repeats.ts'

// In a session, stdout is the MCP pipe: every log line goes to stderr. The time lets one line be matched to another.
export const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[kage]', ...a)
// An address, phone number or chat id as the log may hold it (ADR 0010): the same 8 characters each time, so lines still match up.
export const logRef = (s: string) => createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 8)
// Only the Slack library's warnings collapse (a dropped network repeats one every few seconds); Kage's own lines,
// crashes included, always print.
const once = repeats(10 * 60_000)
const slackWarn = (...a: unknown[]) => { for (const l of once(a.map(x => (typeof x === 'string' ? x : inspect(x))).join(' '), Date.now())) log('warn', l) }
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
