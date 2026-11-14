// Kage's log line, and the logger the Slack clients get.
import { LogLevel } from '@slack/web-api'
import { inspect } from 'node:util'
import { repeats } from '../core/log-repeats.ts'

// In a session, stdout is the MCP pipe: every log line goes to stderr. The time lets one line be matched to another.
export const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[kage]', ...a)
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
