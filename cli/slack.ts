import { spawnSync } from 'node:child_process'
import { installUrl, manifestUrl, pasteSteps, upgradeSteps } from '../core/slack-scopes.ts'
import { addScopes, authTest, checkScopes } from '../runtime/slack-scopes.ts'
import { settings } from './home.ts'

const { secrets } = settings()
const tokens = { user: secrets.slack?.user, bot: secrets.slack?.bot }
const [cmd = ''] = process.argv.slice(2)
const die = (msg: string): never => { console.error(msg); process.exit(1) }
const tryRun = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0
const openPage = (url: string) => tryRun('open', [url]) || tryRun('xdg-open', [url])

function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('')
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise(resolve => {
    let typed = ''
    const done = (value: string) => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onKey); process.stdout.write('\n'); resolve(value.trim()) }
    const onKey = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') { done(''); process.exit(130) }
        if (ch === '\r' || ch === '\n') return done(typed)
        typed = ch === '\u007f' ? typed.slice(0, -1) : typed + ch
      }
    }
    process.stdin.on('data', onKey)
  })
}

const CONFIG_TOKEN_HELP = [
  'Kage can add the scopes to your app for you. It needs a Slack app configuration token once, and does not save it.',
  '1. Open https://api.slack.com/apps (it opens now).',
  '2. Under "Your App Configuration Tokens", click Generate Token, pick this workspace, then copy the Access Token.',
]

if (cmd === 'upgrade') {
  if (!tokens.user || !tokens.bot) die('no Slack tokens saved: run kage save')
  const missing = await checkScopes(tokens)
  if (!missing.bot.length && !missing.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  const auth = await authTest(tokens.bot!)
  const info = auth?.botId ? await fetch(`https://slack.com/api/bots.info?bot=${auth.botId}`, { headers: { Authorization: `Bearer ${tokens.bot}` } }).then(r => r.json() as Promise<{ bot?: { app_id?: string } }>).catch(() => undefined) : undefined
  const appId = info?.bot?.app_id
  const team = auth?.teamId
  if (!appId || !team) die('Could not get the app id from Slack. Open https://api.slack.com/apps, pick the app, click App Manifest, and add the missing scopes to oauth_config.scopes.')
  for (const line of CONFIG_TOKEN_HELP) console.log(line)
  openPage('https://api.slack.com/apps')
  const configToken = await askHidden('Paste the token, or press Enter to edit the manifest by hand: ')
  const added = configToken ? await addScopes(configToken, appId!, missing) : undefined
  if (added && !added.ok) console.log(`Slack did not take the change (${added.error}), so edit the manifest by hand.`)
  if (added?.ok) {
    console.log('ok: added the scopes to your app\'s manifest.')
    openPage(installUrl(appId!))
    for (const line of upgradeSteps(installUrl(appId!))) console.log(line)
  } else {
    const url = manifestUrl(team!, appId!)
    openPage(url)
    for (const line of pasteSteps(missing, url)) console.log(line)
  }
  console.log('Waiting for the new scopes (up to 10 minutes)...')
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const now = await checkScopes(tokens)
    if (!now.bot.length && !now.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  }
  die('The scopes are not there yet. If you reinstalled, run kage save with the new tokens, then kage doctor.')
} else die('Usage: kage slack upgrade')
