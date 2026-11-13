// Settings and Slack clients shared by the router and the per-thread sessions.
import { WebClient, LogLevel } from '@slack/web-api'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { repeats } from './core/log-repeats.ts'
import { validName } from './core/gate.ts'

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

// Tokens live in a private file outside the repo (setup.sh writes it with mode 600).
export function load() {
  const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
  const env: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/.exec(line)
    if (m) env[m[1]!] = m[2]!
  }
  const need = (k: string) => env[k] || (log(`missing ${k} in ${ENV_FILE}`), process.exit(1))
  const NAME = (env.KAGE_NAME || 'kage').toLowerCase()
  if (!validName(NAME)) {
    log(`KAGE_NAME "${NAME}" must be a short lowercase word (letters, digits, dashes)`)
    process.exit(1)
  }
  // Slack user ids, comma separated, who may tag the bot too. Empty: only the owner.
  const TEAMMATES = (env.KAGE_TEAMMATES || '').split(',').map(s => s.trim()).filter(Boolean)
  if (TEAMMATES.some(t => !/^[UW][A-Z0-9]{2,}$/.test(t))) {
    log('KAGE_TEAMMATES must be Slack user ids like U0123ABC, comma separated')
    process.exit(1)
  }
  // Slack app ids of teammates' own agents, whose posts count as that teammate's. Empty: none.
  const TRUSTED_APPS = (env.KAGE_TRUSTED_APPS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (TRUSTED_APPS.some(a => !/^A[A-Z0-9]{2,}$/.test(a))) {
    log('KAGE_TRUSTED_APPS must be Slack app ids like A0123ABC, comma separated')
    process.exit(1)
  }
  return {
    ENV_FILE,
    env,
    need,
    NAME,
    Title: NAME[0]!.toUpperCase() + NAME.slice(1),
    TEAMMATES,
    TRUSTED_APPS,
    bot: new WebClient(need('SLACK_BOT_TOKEN'), { logger }),
    user: new WebClient(need('SLACK_USER_TOKEN'), { logger }),
  }
}
