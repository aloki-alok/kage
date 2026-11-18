import { spawnSync } from 'node:child_process'
import { manifestUrl, upgradeSteps } from '../core/slack-scopes.ts'
import { authTest, checkScopes } from '../runtime/slack-scopes.ts'
import { settings } from './home.ts'

const { secrets } = settings()
const tokens = { user: secrets.slack?.user, bot: secrets.slack?.bot }
const [cmd = ''] = process.argv.slice(2)
const die = (msg: string): never => { console.error(msg); process.exit(1) }

if (cmd === 'upgrade') {
  if (!tokens.user || !tokens.bot) die('no Slack tokens saved: run kage save')
  const missing = await checkScopes(tokens)
  if (!missing.bot.length && !missing.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  const auth = await authTest(tokens.bot!)
  const info = auth?.botId ? await fetch(`https://slack.com/api/bots.info?bot=${auth.botId}`, { headers: { Authorization: `Bearer ${tokens.bot}` } }).then(r => r.json() as Promise<{ bot?: { app_id?: string } }>).catch(() => undefined) : undefined
  const appId = info?.bot?.app_id
  const team = auth?.teamId
  if (!appId || !team) die('Could not get the app id from Slack. Open https://api.slack.com/apps, pick the app, click App Manifest, and add the missing scopes to oauth_config.scopes.')
  const url = manifestUrl(team!, appId!)
  const tryRun = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0
  tryRun('open', [url]) || tryRun('xdg-open', [url])
  for (const line of upgradeSteps(missing, url)) console.log(line)
  console.log('Waiting for the new scopes (up to 10 minutes)...')
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const now = await checkScopes(tokens)
    if (!now.bot.length && !now.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  }
  die('The scopes are not there yet. If you reinstalled, run kage save with the new tokens, then kage doctor.')
} else die('Usage: kage slack upgrade')
