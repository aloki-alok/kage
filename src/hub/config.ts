import { WebClient } from '@slack/web-api'
import { checkSettings } from '../core/config.ts'
import { envFilePath, readSettings } from '../runtime/config-files.ts'
import { log, logger } from '../runtime/log.ts'
import { noteExit } from '../runtime/hub-log.ts'
import { dirname } from 'node:path'

export function load() {
  const ENV_FILE = envFilePath()
  let settings
  try { settings = readSettings(ENV_FILE) } catch (e) { log((e as Error).message); noteExit(dirname(ENV_FILE), 'crash', e); process.exit(1) }
  for (const f of settings.failed()) log(`secrets.json ${f.path} is unset: its command failed or printed nothing (${f.command})`)
  const ok = checkSettings(settings.config, settings.secrets)
  if ('error' in ok) {
    log(`${ok.error} (${ENV_FILE})`)
    noteExit(dirname(ENV_FILE), 'crash', `settings refused: ${ok.error}`)
    process.exit(1)
  }
  const { name: NAME, teammates: TEAMMATES, trusted: TRUSTED_PEOPLE, emails: TEAMMATE_EMAILS, apps: TRUSTED_APPS } = ok
  return {
    ENV_FILE,
    config: settings.config,
    secrets: settings.secrets,
    NAME,
    Title: NAME[0]!.toUpperCase() + NAME.slice(1),
    TEAMMATES,
    TRUSTED_PEOPLE,
    TEAMMATE_EMAILS,
    TRUSTED_APPS,
    bot: new WebClient(settings.secrets.slack!.bot!, { logger }),
    user: new WebClient(settings.secrets.slack!.user!, { logger }),
  }
}
