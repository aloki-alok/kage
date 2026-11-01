// Settings and Slack clients shared by the router and the per-thread sessions.
import { WebClient, LogLevel } from '@slack/web-api'
import { readFileSync } from 'node:fs'
import { validName } from './logic.ts'

// In a session, stdout is the MCP pipe: every log line goes to stderr.
export const log = (...a: unknown[]) => console.error('[kage]', ...a)
let level = LogLevel.WARN
export const logger = {
  debug: () => {},
  info: () => {},
  warn: (...a: unknown[]) => log('warn', ...a),
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
  return {
    ENV_FILE,
    env,
    need,
    NAME,
    Title: NAME[0]!.toUpperCase() + NAME.slice(1),
    TEAMMATES,
    bot: new WebClient(need('SLACK_BOT_TOKEN'), { logger }),
    user: new WebClient(need('SLACK_USER_TOKEN'), { logger }),
  }
}
