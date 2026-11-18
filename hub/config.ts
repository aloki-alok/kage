import { WebClient } from '@slack/web-api'
import { checkSettings } from '../core/config.ts'
import { envFilePath, readSettings } from '../runtime/config-files.ts'
import { log, logger } from '../runtime/log.ts'

export function load() {
  const ENV_FILE = envFilePath()
  let settings
  try { settings = readSettings(ENV_FILE) } catch (e) { log((e as Error).message); process.exit(1) }
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
