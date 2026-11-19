import { spawnSync } from 'node:child_process'
import { installUrl, manifestUrl, pasteSteps, upgradeSteps } from '../core/slack-scopes.ts'
import { addScopes, authTest, checkScopes } from '../runtime/slack-scopes.ts'
import { SECRETS } from '../core/secret-prompt.ts'
import { askSecret } from '../runtime/terminal-secret.ts'
import { errVoice, voice } from './voice.ts'
import { settings } from './home.ts'

const { secrets } = settings()
const tokens = { user: secrets.slack?.user, bot: secrets.slack?.bot }
const [cmd = ''] = process.argv.slice(2)
const die = (msg: string): never => { console.error(errVoice.says(msg)); process.exit(1) }
const need = (n: number) => `I need ${n === 1 ? 'one Slack permission' : `${n} Slack permissions`} your app doesn't have yet.`
const tryRun = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0
const openPage = (url: string) => tryRun('open', [url]) || tryRun('xdg-open', [url])

const CONFIG_TOKEN_HELP = [
  'I can add them myself with a Slack configuration token. I use it once and never save it.',
  '1. Open https://api.slack.com/apps (it opens now).',
  '2. Scroll below your apps to "Your App Configuration Tokens" and click Generate Token.',
  '3. Pick this workspace and click Generate.',
  '4. Copy the Access Token (xoxe.xoxp-...), not the Refresh Token.',
]

if (cmd === 'upgrade') {
  if (!tokens.user || !tokens.bot) die('I have no Slack tokens yet. Run kage save first.')
  const missing = await checkScopes(tokens)
  if (!missing.bot.length && !missing.user.length) { console.log(voice.says('Your Slack app already has every permission I need.')); process.exit(0) }
  const auth = await authTest(tokens.bot!)
  const info = auth?.botId ? await fetch(`https://slack.com/api/bots.info?bot=${auth.botId}`, { headers: { Authorization: `Bearer ${tokens.bot}` } }).then(r => r.json() as Promise<{ bot?: { app_id?: string } }>).catch(() => undefined) : undefined
  const appId = info?.bot?.app_id
  const team = auth?.teamId
  if (!appId || !team) die("Slack didn't tell me which app is mine. Open https://api.slack.com/apps, pick the app, click App Manifest, and add the missing scopes under oauth_config.scopes.")
  console.log(voice.says(need(missing.bot.length + missing.user.length)))
  for (const line of CONFIG_TOKEN_HELP) console.log(line)
  openPage('https://api.slack.com/apps')
  const configToken = await askSecret('Access Token (Enter: by hand): ', SECRETS.config, true)
  const added = configToken ? await addScopes(configToken, appId!, missing) : undefined
  if (added && !added.ok) console.log(voice.says(`Slack didn't take the change (${added.error}), so let's do it by hand.`))
  if (added?.ok) {
    console.log(voice.says("Added them to your app. One click left:"))
    openPage(installUrl(appId!))
    for (const line of upgradeSteps(installUrl(appId!))) console.log(line)
  } else {
    const url = manifestUrl(team!, appId!)
    openPage(url)
    for (const line of pasteSteps(missing, url)) console.log(line)
  }
  console.log(voice.dim('\nI\'ll wait here until Slack shows them (up to 10 minutes).'))
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const now = await checkScopes(tokens)
    if (!now.bot.length && !now.user.length) { console.log(voice.says('All set. I have every permission I need.')); process.exit(0) }
  }
  die("I still don't see them. If you reinstalled, run kage save with the new tokens, then kage doctor.")
} else die('Try: kage slack upgrade')
