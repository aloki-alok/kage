import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { countBoot, noteExit, npmCi, packagesStale, rotate } from './src/runtime/hub-log.ts'

const DIR = import.meta.dirname
const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
const CONF = dirname(ENV_FILE)
const say = (line: string) => console.error(`${new Date().toISOString()} hub.ts: ${line}`)

const envValue = (text: string, key: string) =>
  text.split('\n').filter(l => l.startsWith(`${key}=`)).map(l => l.slice(key.length + 1)).at(-1)

const secretValue = (v: unknown) => {
  if (typeof v === 'string') return v
  const command = (v as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string') return undefined
  try { return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '') || undefined } catch { return undefined }
}

const lastLines = (log: string) => {
  try { return readFileSync(log, 'utf8').split('\n').slice(-40).filter(l => l.trim() && !/^\s*at /.test(l)).slice(-5).join('\n') } catch { return '' }
}

async function slack(method: string, token: string, form: Record<string, string> = {}) {
  const r = await fetch(`${process.env.KAGE_SLACK_API || 'https://slack.com/api'}/${method}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000),
  })
  return await r.json() as { ok: boolean; user_id?: string }
}

async function crashLoopDm(tokensOf: () => { user: string; bot: string }, boots: number, last: string, now: number) {
  const sentAt = `${CONF}/crash-dm-at`
  if (boots < 3 || now - Number(existsSync(sentAt) ? readFileSync(sentAt, 'utf8') : 0) < 3600) return
  try {
    const tokens = tokensOf()
    const owner = (await slack('auth.test', tokens.user)).user_id
    const text = `Kage started ${boots} times in 10 minutes, so it is probably crashing. The last lines of its log:\n\`\`\`\n${last}\n\`\`\`\nRun kage logs for more.`
    if (owner && (await slack('chat.postMessage', tokens.bot, { channel: owner, text })).ok) writeFileSync(sentAt, String(now))
    else say('could not DM the owner about the restarts')
  } catch (e) { say(`could not DM the owner about the restarts: ${e}`) }
}

function claudeCommand(route: string | undefined) {
  let tools = ''
  for (const t of ['reply', 'edit_message', 'delete_message', 'send_file', 'make_canvas', 'edit_canvas', 'message_people', 'schedule', 'unschedule', 'schedules']) tools += ` mcp__kage__${t} mcp__plugin_kage_kage__${t}`
  tools += ` --disallowedTools CronCreate CronDelete CronList`
  if (route === 'plugin') return `claude --channels plugin:kage@kage --allowedTools${tools}`
  const mcp = JSON.stringify({ mcpServers: { kage: { command: process.execPath, args: [join(DIR, 'plugin', 'server.ts')] } } })
  return `claude --mcp-config '${mcp}' --allowedTools${tools} --dangerously-load-development-channels server:kage`
}

{
  if (!existsSync(ENV_FILE) && !existsSync(`${CONF}/config.json`)) { console.error(`No settings in ${CONF} yet. Run kage setup first.`); process.exit(0) }
  const log = `${CONF}/hub.log`
  rotate(log)
  let files: typeof import('./src/runtime/config-files.ts') | undefined
  try {
    files = await import('./src/runtime/config-files.ts')
    const to = files.importLegacy(ENV_FILE)
    if (to) say(`imported the env file into config.json and secrets.json; the old file is now ${to} and goes in 7 days`)
    if (files.syncWaha(ENV_FILE)) say('wrote waha/.env from secrets.json: restart the WhatsApp container so it reads the new keys')
  } catch (e) { say(`could not import the env file: ${e}`) }
  const json = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }
  const cfg = json(`${CONF}/config.json`), sec = json(`${CONF}/secrets.json`)
  const legacy = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const tokens = () => ({ user: secretValue(sec.slack?.user) ?? envValue(legacy, 'SLACK_USER_TOKEN') ?? '', bot: secretValue(sec.slack?.bot) ?? envValue(legacy, 'SLACK_BOT_TOKEN') ?? '' })
  const home = (p: string) => (p === '~' ? process.env.HOME! : p.startsWith('~/') ? process.env.HOME + p.slice(1) : p)
  const last = lastLines(log)
  const now = Math.floor(Date.now() / 1000)
  const boots = countBoot(CONF, now)
  say(`hub start ${boots} in the last 10 minutes`)
  await crashLoopDm(tokens, boots, last, now)

  const sessionEnv = `${CONF}/session.env`
  if (existsSync(sessionEnv)) {
    if ((statSync(sessionEnv).mode & 0o777) === 0o600) process.loadEnvFile(sessionEnv)
    else say(`${sessionEnv} is not private, so it was skipped. Run chmod 600 on it.`)
  }
  try { for (const [k, v] of Object.entries((await import('./src/core/config.ts')).unknownEnv(cfg, sec))) process.env[k] ??= v }
  catch (e) { say(`could not export the env file's own keys: ${e}`) }
  const claudeToken = secretValue(sec.claudeToken)
  if (claudeToken) { process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeToken; delete process.env.ANTHROPIC_API_KEY }
  await (await import('./src/runtime/hold-keys.ts')).holdKeys(Object.keys(cfg.sessionKeys ?? {}), say)
  const mem = home(cfg.harness?.memory ?? envValue(legacy, 'KAGE_MEMORY') ?? '') || `${CONF}/memory`
  if (/['"\\]/.test(mem + DIR)) { say('Move kage or KAGE_MEMORY to a path without quotes or backslashes.'); process.exit(0) }
  mkdirSync(mem, { recursive: true })
  process.env.KAGE_ENV = ENV_FILE
  process.env.KAGE_CLAUDE = claudeCommand(cfg.harness?.route ?? envValue(legacy, 'KAGE_ROUTE'))
  process.env.KAGE_CWD = home(cfg.harness?.cwd ?? envValue(legacy, 'KAGE_CWD') ?? '') || process.env.KAGE_CWD || process.env.HOME!
  process.chdir(process.env.KAGE_CWD)
  try { await import('./src/hub/router.ts') } catch (e) {
    console.error(e)
    if (!packagesStale(DIR)) { say('the hub could not load: read the error above'); noteExit(CONF, 'crash', e); process.exit(1) }
    say('the hub could not load and its packages are behind package-lock.json: running npm ci, then restarting')
    try { npmCi(DIR) } catch { say(`npm ci failed: run it in ${DIR} and read the error`); noteExit(CONF, 'crash', 'npm ci failed'); process.exit(1) }
    noteExit(CONF, 'update')
    process.exit(75)
  }
}
