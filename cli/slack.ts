// kage slack check:   one doctor line per finding on the app's scopes (exit 1 when scopes are missing).
// kage slack upgrade: puts the current manifest on the clipboard, opens the app's manifest page, and waits for the new scopes.
import { spawnSync } from 'node:child_process'
import { scopeLines } from '../core/slack-scopes.ts'
import { authTest, checkScopes } from '../runtime/slack-scopes.ts'
import { settings } from './home.ts'

const { config, secrets } = settings()
const tokens = { user: secrets.slack?.user, bot: secrets.slack?.bot }
const [cmd = ''] = process.argv.slice(2)
const die = (msg: string): never => { console.error(msg); process.exit(1) }

if (cmd === 'check') {
  if (!tokens.user || !tokens.bot) die('no Slack tokens saved: run kage save')
  const lines = scopeLines(await checkScopes(tokens))
  for (const l of lines) console.log(`${l.ok ? 'ok' : 'FAIL'} ${l.text}`)
  process.exit(lines.every(l => l.ok) ? 0 : 1)
} else if (cmd === 'upgrade') {
  if (!tokens.user || !tokens.bot) die('no Slack tokens saved: run kage save')
  const missing = await checkScopes(tokens)
  if (!missing.bot.length && !missing.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  // auth.test gives the bot id, and bots.info (users:read, which the bot holds) gives the app id.
  const botId = (await authTest(tokens.bot!))?.botId
  const info = botId ? await fetch(`https://slack.com/api/bots.info?bot=${botId}`, { headers: { Authorization: `Bearer ${tokens.bot}` } }).then(r => r.json() as Promise<{ bot?: { app_id?: string } }>).catch(() => undefined) : undefined
  const appId = info?.bot?.app_id
  if (!appId) die('Could not get the app id from Slack. Open https://api.slack.com/apps, pick the app, and paste the manifest under App Manifest.')
  const manifest = spawnSync(process.execPath, [new URL('./manifest.ts', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, KAGE_NAME: config.name || 'kage' } }).stdout
  const tryRun = (bin: string, args: string[], input?: string) => spawnSync(bin, args, { input, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] }).status === 0
  const copied = tryRun('pbcopy', [], manifest) || tryRun('wl-copy', [], manifest) || tryRun('xclip', ['-selection', 'clipboard'], manifest)
  const url = `https://api.slack.com/apps/${appId}/app-manifest`
  tryRun('open', [url]) || tryRun('xdg-open', [url])
  if (!copied) console.log(`No clipboard tool found. Copy this manifest:\n\n${manifest}\n`)
  console.log(`1. ${copied ? 'The manifest is on your clipboard. ' : ''}Open ${url} if it did not open.`)
  console.log('2. Select all the text there, paste the manifest over it, and click Save Changes.')
  console.log('3. Click "Reinstall to Workspace" in the yellow banner, then click Allow.')
  console.log('4. If Slack shows new tokens under Install App, run kage save to enter them.')
  console.log('Waiting for the new scopes (up to 10 minutes)...')
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const now = await checkScopes(tokens)
    if (!now.bot.length && !now.user.length) { console.log('ok: the Slack app has every scope'); process.exit(0) }
  }
  die('The scopes are not there yet. If you reinstalled, run kage save with the new tokens, then kage doctor.')
} else die('Usage: kage slack check | kage slack upgrade')
