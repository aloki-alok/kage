// Settings and Slack clients shared by the router and the per-thread sessions.
import { WebClient, LogLevel } from '@slack/web-api'
import { inspect } from 'node:util'
import { repeats } from './core/log-repeats.ts'
import { checkSettings } from './core/config.ts'
import { readSettings } from './runtime/config-files.ts'

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

// Settings live in config.json, tokens in secrets.json (mode 600), both outside the repo (runtime/config-files.ts).
export function load() {
  const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
  let settings
  try { settings = readSettings(ENV_FILE) } catch (e) { log((e as Error).message); process.exit(1) }
  // At the start there are no older settings to keep, so a wrong file stops the hub. A change while it runs keeps the old ones (runtime/config-watch.ts).
  const ok = checkSettings(settings.config, settings.secrets)
  if ('error' in ok) {
    log(`${ok.error} (${ENV_FILE})`)
    process.exit(1)
  }
  const { name: NAME, teammates: TEAMMATES, apps: TRUSTED_APPS } = ok
  return {
    ENV_FILE,
    config: settings.config,
    secrets: settings.secrets,
    NAME,
    Title: NAME[0]!.toUpperCase() + NAME.slice(1),
    TEAMMATES,
    TRUSTED_APPS,
    bot: new WebClient(settings.secrets.slack!.bot!, { logger }),
    user: new WebClient(settings.secrets.slack!.user!, { logger }),
  }
}
