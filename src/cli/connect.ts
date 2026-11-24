import { randomBytes } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { addBrowserAgainLines, addBrowserLines, addBrowserPlan, extensionId, HOST, hostBrowsers, hostManifest } from '../core/browser-pair.ts'
import { choiceAsk, connectAsks, connectLines, connectorStates, connectorStep, OFF_NOTES, type Ask, type ConnectorName } from '../core/connect.ts'
import { typeLines } from '../core/secret-prompt.ts'
import { createInterface } from 'node:readline/promises'
import { readSettings, setKey, updateConfig, updateSecrets } from '../runtime/config-files.ts'
import type { Config } from '../core/config.ts'
import { DIR, ENV_FILE, settingsExist } from './home.ts'
import { createApp } from './github-app.ts'
import { githubOwner } from '../core/github.ts'
import { tailscaleBin, tailscaleState } from './tailscale.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [name, ...args] = process.argv.slice(2)
const NAMES: ConnectorName[] = ['github', 'browser', 'email', 'voice', 'whatsapp', 'meeting', 'sms']
const SWITCHED = ['email', 'voice', 'whatsapp', 'sms'] as const
if (!settingsExist()) die(`No settings in ${DIR}. Run kage setup first.`)
const state = () => connectorStates(readSettings(ENV_FILE))
const change = (write: () => void) => { try { write() } catch (e) { die((e as Error).message) } }

if (!name) { console.log(connectLines(state()).join('\n')); process.exit(0) }
if (!NAMES.includes(name as ConnectorName)) die(`kage connect takes github, browser, email, voice, whatsapp, meeting or sms, not ${name}.`)
const n = name as ConnectorName
const off = args[0] === 'off'

const quit: (line: string) => never = line => { console.log(line); process.exit(0) }
if (n === 'github') await connectGithub()
const before = state()[n]
if (off && before.state === 'unset') quit(`${n} is not set up, so it is off already.`)
if (off && before.state === 'off') quit(`${n} is off already.`)
if (n === 'browser' && off) {
  change(() => updateSecrets(ENV_FILE, ({ browserToken: _, ...s }) => s))
  quit(`browser is off. ${OFF_NOTES.browser}`)
}
if (n === 'browser') pairBrowser()
if (n === 'meeting' && off) die('The meeting bot has no off switch yet. Remove meetingToken from secrets.json to turn it off.')
const switched = SWITCHED.find(k => k === n)
const turned = (c: Config): Config => {
  const { on: _, ...rest } = c.connectors?.[switched!] ?? {}
  return { ...c, connectors: { ...c.connectors, [switched!]: off ? { ...rest, on: false } : rest } }
}
if (off) { change(() => updateConfig(ENV_FILE, turned)); quit(`${n} is off. ${OFF_NOTES[n] ?? ''}`.trim()) }
const settle = () => {
  const now = readSettings(ENV_FILE)
  const after = switched ? connectorStates({ ...now, config: turned(now.config) })[n] : state()[n]
  if (switched && after.state === 'on' && state()[n].state !== 'on') change(() => updateConfig(ENV_FILE, turned))
  if (after.state === 'on') quit(`${n} is on. Kage picks it up once it is not in the middle of anything.`)
  return after
}
const left = settle()
if (left.state === 'unset' && process.stdin.isTTY && !args.includes('--no-ask')) console.log(`${n} needs a few settings. Kage makes what it can and asks for the rest. Each answer is saved as you go, and an empty one stops.`)
if (left.state === 'unset' && process.stdin.isTTY && !args.includes('--no-ask')) {
  const choice = choiceAsk(n, readSettings(ENV_FILE).config)
  if (choice) await ask([choice])
  const now = settle()
  if (now.state === 'unset') await ask(connectAsks(now.missing))
  settle()
}
die(`${n} ${connectorStep(n, settle())}`)

async function ask(asks: Ask[]) {
  for (const a of asks) {
    if (a.kind === 'made') {
      const token = randomBytes(24).toString('hex')
      change(() => updateSecrets(ENV_FILE, s => secretAt(s, a.key, token)))
      console.log(a.show ? `Made ${a.key}: ${a.question}. Token: ${token}` : `Made ${a.key}: ${a.question}.`)
      continue
    }
    for (;;) {
      const value = a.kind === 'secret' ? await hidden(`${a.question} `) : await line(`${a.question} `)
      if (!value) quit(`Stopped. ${n} ${connectorStep(n, settle())}`)
      const problem = a.check?.(value)
      if (problem) { console.log(problem); continue }
      try { if (a.kind === 'secret') updateSecrets(ENV_FILE, s => secretAt(s, a.key, value)); else setKey(ENV_FILE, a.key, value); break } catch (e) { console.log((e as Error).message.replace(/^config\.json: /, '')) }
    }
  }
}

function secretAt<T extends Record<string, unknown>>(s: T, key: string, value: string): T {
  const [head, sub] = key.split('.') as [string, string | undefined]
  return sub ? { ...s, [head]: { ...s[head] as object, [sub]: value } } : { ...s, [head]: value }
}

async function line(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(prompt)).trim() } catch { console.log(); return '' } finally { rl.close() }
}

function hidden(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return new Promise(resolve => {
    let typed = ''
    const onKey = (chunk: Buffer) => {
      const r = typeLines(typed, chunk.toString('utf8'))
      if (r.cancel) { process.stdin.setRawMode(false); console.log(); process.exit(130) }
      typed = r.typed
      const done = r.lines.find(l => l.trim())
      if (done !== undefined || r.lines.length) { process.stdin.off('data', onKey); process.stdin.setRawMode(false); process.stdin.pause(); console.log(); resolve((done ?? '').trim()) }
    }
    process.stdin.setRawMode(true); process.stdin.on('data', onKey); process.stdin.resume()
  })
}

function pairBrowser(): never {
  const plan = addBrowserPlan({ hasToken: !!readSettings(ENV_FILE).secrets.browserToken, reinstall: args.includes('--reinstall') })
  if (!plan.newToken && !args.includes('--show-token')) { console.log(addBrowserAgainLines().join('\n')); process.exit(0) }
  const token = plan.newToken ? randomBytes(24).toString('hex') : readSettings(ENV_FILE).secrets.browserToken!
  if (plan.newToken) change(() => updateSecrets(ENV_FILE, s => ({ ...s, browserToken: token })))
  const ext = fileURLToPath(new URL('../../extension', import.meta.url))
  const id = extensionId(JSON.parse(readFileSync(`${ext}/manifest.json`, 'utf8')).key)
  const helper = `${DIR}/browser-pair.sh`
  const pairer = fileURLToPath(new URL('./browser-pair.ts', import.meta.url))
  if ([ENV_FILE, process.execPath, pairer].some(p => p.includes("'"))) die('A path here holds a quote mark, which the pairing helper cannot name. Move Kage or node to a path without one.')
  writeFileSync(helper, `#!/bin/sh\nKAGE_ENV='${ENV_FILE}' exec '${process.execPath}' '${pairer}'\n`, { mode: 0o700 })
  const found = hostBrowsers(process.platform, process.env.HOME!, existsSync)
  for (const { dir } of found) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${HOST}.json`, JSON.stringify(hostManifest(helper, id), null, 2) + '\n')
  }
  const run = (cmd: string, a: string[], input?: string) => spawnSync(cmd, a, { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }).status === 0
  const mac = process.platform === 'darwin'
  if (!plan.open) { console.log(`Token: ${token}`); process.exit(0) }
  const opened = mac ? run('open', ['-a', 'Google Chrome', 'chrome://extensions']) : ['google-chrome', 'chromium', 'brave-browser', 'microsoft-edge'].some(b => run('which', [b]) && (spawn(b, ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref(), true))
  const revealed = mac && run('open', ['-R', ext])
  console.log(addBrowserLines({ names: found.map(b => b.name), ext, token, showToken: args.includes('--show-token'), platform: process.platform, opened, revealed }).join('\n'))
  process.exit(0)
}

async function connectGithub(): Promise<never> {
  const s = readSettings(ENV_FILE), gh = s.config.connectors?.github ?? {}
  const at = args.indexOf('--org'), org = at >= 0 ? args[at + 1] : undefined
  if (at >= 0 && !/^[\w-]+$/.test(org ?? '')) die('Usage: kage connect github --org <org name>')
  const github = (g: NonNullable<NonNullable<Config['connectors']>['github']>) => change(() => updateConfig(ENV_FILE, c => ({ ...c, connectors: { ...c.connectors, github: g } })))
  const install = (slug: string) => `https://github.com/apps/${slug}/installations/new`
  if (off) {
    if (!gh.app) quit('github is not set up, so it is off already.')
    const { app, ...rest } = gh
    change(() => updateSecrets(ENV_FILE, ({ githubAppKey: _k, githubSecret: _s, githubToken: _t, ...x }) => x))
    github(rest)
    quit(`github is off. The app @${app.slug} stays on GitHub until you delete it: https://github.com/apps/${app.slug}, then App settings, Advanced, Delete. Then kage tunnel on closes its public address.`)
  }
  const owner = (needId: boolean) => {
    const who = githubOwner({ login: gh.login ?? undefined, userId: gh.userId, me: gh.userId ? undefined : ghUser(), needId })
    return 'error' in who ? die(who.error) : who
  }
  if (gh.app && s.secrets.githubAppKey && s.secrets.githubSecret) {
    const accounts = [...new Set([...(gh.accounts ?? [gh.login ?? '']), ...(org ? [org] : [])].filter(Boolean))]
    const { userId } = owner(true)
    if (org || !gh.userId) github({ ...gh, userId, accounts })
    browse(install(gh.app.slug))
    quit(`github is on as @${gh.app.slug} for ${accounts.join(', ')}. Install it where people should tag it: ${install(gh.app.slug)}`)
  }
  const bin = tailscaleBin(), ts = bin ? tailscaleState(bin) : undefined, host = ts?.dns?.replace(/\.$/, '')
  if (!ts?.running || !ts.funnel || !host) die('GitHub needs a public address for the app. Run kage tunnel on, allow Funnel when it asks, then run kage connect github again.')
  const { login, userId: known } = owner(!!org)
  console.log('Opening GitHub. Click Create GitHub App there, and Kage takes it from here.')
  const app = await createApp({ login, org, hook: `https://${host}:8443/github`, open: browse }).catch((e: Error) => die(e.message))
  change(() => updateSecrets(ENV_FILE, x => ({ ...x, githubAppKey: app.key, githubSecret: app.secret })))
  github({ ...gh, login, userId: known ?? app.ownerId, app: { id: app.id, slug: app.slug }, accounts: [...new Set([login, ...(org ? [org] : []), ...(gh.accounts ?? [])])] })
  spawnSync(process.execPath, [fileURLToPath(new URL('./tunnel.ts', import.meta.url)), 'on'], { stdio: 'inherit', env: process.env })
  quit(`github is on as @${app.slug}. Install it from the tab Kage opened, or at ${app.url}/installations/new, then tag @${app.slug} in an issue to try it.`)
}

function ghUser(): { login: string; id: number } | undefined {
  try { return JSON.parse(execFileSync('gh', ['api', 'user', '--jq', '{login, id}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })) } catch { return undefined }
}

function browse(url: string) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  if (!process.stdout.isTTY || spawnSync(opener, [url], { stdio: 'ignore', timeout: 5000 }).status !== 0) console.log(`Open ${url}`)
}
