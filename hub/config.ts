// Settings and Slack clients shared by the router and the per-thread sessions.
import { WebClient } from '@slack/web-api'
import { checkSettings } from '../core/config.ts'
import { readSettings } from '../runtime/config-files.ts'
import { log, logger } from '../runtime/log.ts'

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
