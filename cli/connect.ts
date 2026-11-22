import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { addBrowserAgainLines, addBrowserLines, addBrowserPlan, extensionId, HOST, hostBrowsers, hostManifest } from '../core/browser-pair.ts'
import { connectLines, connectorStates, connectorStep, OFF_NOTES, type ConnectorName } from '../core/connect.ts'
import { readSettings, updateConfig, updateSecrets } from '../runtime/config-files.ts'
import { DIR, ENV_FILE, settingsExist } from './home.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [name, ...args] = process.argv.slice(2)
const NAMES: ConnectorName[] = ['github', 'browser', 'email', 'voice', 'whatsapp', 'meeting']
const SWITCHED = ['email', 'voice', 'whatsapp'] as const
if (!settingsExist()) die(`No settings in ${DIR}. Run kage setup first.`)
const state = () => connectorStates(readSettings(ENV_FILE))
const change = (write: () => void) => { try { write() } catch (e) { die((e as Error).message) } }

if (!name) { console.log(connectLines(state()).join('\n')); process.exit(0) }
if (!NAMES.includes(name as ConnectorName)) die(`kage connect takes github, browser, email, voice, whatsapp or meeting, not ${name}.`)
const n = name as ConnectorName
const off = args[0] === 'off'

if (n === 'github') die('Run kage connect github: setup.sh walks it.')
if (n === 'browser' && off) {
  change(() => updateSecrets(ENV_FILE, ({ browserToken: _, ...s }) => s))
  console.log(`browser is off. ${OFF_NOTES.browser}`)
  process.exit(0)
}
if (n === 'browser') pairBrowser()
if (n === 'meeting' && off) die('The meeting bot has no off switch yet. Remove meetingToken from secrets.json to turn it off.')
const switched = SWITCHED.find(k => k === n)
if (switched && (off || readSettings(ENV_FILE).config.connectors?.[switched]?.on === false)) change(() => updateConfig(ENV_FILE, c => {
  const { on: _, ...rest } = c.connectors?.[switched] ?? {}
  return { ...c, connectors: { ...c.connectors, [switched]: off ? { ...rest, on: false } : rest } }
}))
const now = state()[n]
if (off) { console.log(`${n} is off. ${OFF_NOTES[n] ?? ''}`.trim()); process.exit(0) }
if (now.state === 'on') { console.log(`${n} is on. Kage picks it up once it is not in the middle of anything.`); process.exit(0) }
die(`${n} ${connectorStep(n, now)}`)

function pairBrowser(): never {
  const plan = addBrowserPlan({ hasToken: !!readSettings(ENV_FILE).secrets.browserToken, reinstall: args.includes('--reinstall') })
  if (!plan.newToken && !args.includes('--show-token')) { console.log(addBrowserAgainLines().join('\n')); process.exit(0) }
  const token = plan.newToken ? randomBytes(24).toString('hex') : readSettings(ENV_FILE).secrets.browserToken!
  if (plan.newToken) change(() => updateSecrets(ENV_FILE, s => ({ ...s, browserToken: token })))
  const ext = fileURLToPath(new URL('../extension', import.meta.url))
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
