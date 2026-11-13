// Settings and Slack clients shared by the router and the per-thread sessions.
import { WebClient, LogLevel } from '@slack/web-api'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { repeats } from './core/log-repeats.ts'
import { checkEnv, parseEnv } from './core/settings.ts'

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
  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'))
  // At the start there are no older settings to keep, so a wrong file stops the hub. A reload keeps the old ones (core/settings.ts).
  const ok = checkEnv(env)
  if ('error' in ok) {
    log(`${ok.error} (${ENV_FILE})`)
    process.exit(1)
  }
  const need = (k: string) => env[k]!
  const { name: NAME, teammates: TEAMMATES, apps: TRUSTED_APPS } = ok
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
