import { LogLevel } from '@slack/web-api'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { repeats } from '../core/log-repeats.ts'

let tap: ((first: unknown) => void) | undefined
export const tapLog = (f: (first: unknown) => void) => { tap = f }
export const log = (...a: unknown[]) => { console.error(new Date().toISOString(), '[kage]', ...a); tap?.(a[0]) }
export const logRef = (s: string) => createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 8)
export const logKey = (key: string) => key.replace(/wa:(.+)$/, (_, chat: string) => `wa:${logRef(chat)}`)
const once = repeats(10 * 60_000)
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
