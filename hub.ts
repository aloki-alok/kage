// The hub's entry: what launchd or systemd runs (service.sh), or `kage run` under any other supervisor.
// It uses only Node's own modules and loads hub/router.ts last, so a bad pull that breaks the hub's code or its
// packages is still caught here: logged, counted, and after 3 starts in 10 minutes sent to the owner as a DM.
// The supervisor's rule: a non-zero exit restarts the hub, and exit 0 (kage stop, a second hub) leaves it down.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { npmCi, packagesStale, rotate } from './runtime/hub-log.ts'

const DIR = import.meta.dirname
const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
const CONF = dirname(ENV_FILE)
const say = (line: string) => console.error(`${new Date().toISOString()} hub.ts: ${line}`)

// Only what the hub needs before the router loads, read with no packages (the router's own reader checks the whole file).
// config.json and secrets.json once imported. The env file's last line for a key wins, as in the hub's own parser.
const envValue = (text: string, key: string) =>
  text.split('\n').filter(l => l.startsWith(`${key}=`)).map(l => l.slice(key.length + 1)).at(-1)

// Starts in the last day stay in the file, for the doctor. Returns how many fell in the last 10 minutes.
function countBoot(file: string, now: number): number {
  let times: number[] = []
  try { times = readFileSync(file, 'utf8').split('\n').map(Number).filter(t => t > now - 86_400) } catch {}
  times.push(now)
  writeFileSync(file, times.join('\n') + '\n')
  return times.filter(t => t > now - 600).length
}

// The last lines of how the run before this one ended, with stack frames left out.
const lastLines = (log: string) => {
  try { return readFileSync(log, 'utf8').split('\n').slice(-40).filter(l => l.trim() && !/^\s*at /.test(l)).slice(-5).join('\n') } catch { return '' }
}

async function slack(method: string, token: string, form: Record<string, string> = {}) {
  const r = await fetch(`${process.env.KAGE_SLACK_API || 'https://slack.com/api'}/${method}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000),
  })
  return await r.json() as { ok: boolean; user_id?: string }
}

// 3 starts in 10 minutes: DM the owner, at most once an hour.
async function crashLoopDm(tokens: { user: string; bot: string }, boots: number, last: string, now: number) {
  const sentAt = `${CONF}/crash-dm-at`
  if (boots < 3 || now - Number(existsSync(sentAt) ? readFileSync(sentAt, 'utf8') : 0) < 3600) return
  try {
    const owner = (await slack('auth.test', tokens.user)).user_id
    const text = `Kage started ${boots} times in 10 minutes, so it is probably crashing. The last lines of its log:\n\`\`\`\n${last}\n\`\`\`\nRun kage logs for more.`
    if (owner && (await slack('chat.postMessage', tokens.bot, { channel: owner, text })).ok) writeFileSync(sentAt, String(now))
    else say('could not DM the owner about the restarts')
  } catch (e) { say(`could not DM the owner about the restarts: ${e}`) }
}

// The command that starts Claude Code in a tmux pane. A session inherits it, which is how kage commands know they run inside Kage.
function claudeCommand(route: string | undefined) {
  let tools = ''
  for (const t of ['reply', 'edit_message', 'delete_message', 'send_file', 'message_people', 'schedule', 'unschedule', 'schedules']) tools += ` mcp__kage__${t} mcp__plugin_kage_kage__${t}`
  tools += ` --disallowedTools CronCreate CronDelete CronList`
  // The plugin route only works once your org approves the channel, so it is opt-in: KAGE_ROUTE=plugin.
  if (route === 'plugin') return `claude --channels plugin:kage@kage --allowedTools${tools}`
  const mcp = JSON.stringify({ mcpServers: { kage: { command: process.execPath, args: [join(DIR, 'plugin', 'server.ts')] } } })
  return `claude --mcp-config '${mcp}' --allowedTools${tools} --dangerously-load-development-channels server:kage`
}

{
  if (!existsSync(ENV_FILE) && !existsSync(`${CONF}/config.json`)) { console.error(`No settings in ${CONF} yet. Run kage setup first.`); process.exit(0) }
  const log = `${CONF}/hub.log`
  rotate(log)
  // First start of the new code: the env file becomes config.json and secrets.json (runtime/config-files.ts). It needs the
  // packages, so a failure here is logged and the router's own load below reports it the usual way.
  let files: typeof import('./runtime/config-files.ts') | undefined
  try {
    files = await import('./runtime/config-files.ts')
    const to = files.importLegacy(ENV_FILE)
    if (to) say(`imported the env file into config.json and secrets.json; the old file is now ${to} and goes in 7 days`)
    if (files.syncWaha(ENV_FILE)) say('wrote waha/.env from secrets.json: restart the WhatsApp container so it reads the new keys')
  } catch (e) { say(`could not import the env file: ${e}`) }
  const json = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }
  const cfg = json(`${CONF}/config.json`), sec = json(`${CONF}/secrets.json`)
  const legacy = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''   // only when the import could not run
  const tokens = { user: sec.slack?.user ?? envValue(legacy, 'SLACK_USER_TOKEN') ?? '', bot: sec.slack?.bot ?? envValue(legacy, 'SLACK_BOT_TOKEN') ?? '' }
  const home = (p: string) => (p === '~' ? process.env.HOME! : p.startsWith('~/') ? process.env.HOME + p.slice(1) : p)
  const last = lastLines(log)
  const now = Math.floor(Date.now() / 1000)
  const boots = countBoot(`${CONF}/boots`, now)
  say(`hub start ${boots} in the last 10 minutes`)
  await crashLoopDm(tokens, boots, last, now)

  // Sessions see the supervisor's environment, not your shell's. Exports they need go in session.env, which must be private.
  const sessionEnv = `${CONF}/session.env`
  if (existsSync(sessionEnv)) {
    if ((statSync(sessionEnv).mode & 0o777) === 0o600) process.loadEnvFile(sessionEnv)
    else say(`${sessionEnv} is not private, so it was skipped. Run chmod 600 on it.`)
  }
  // The old env file's own keys (a tool's API key) were in the hub's environment before the import moved them into the
  // settings files, so they still are. session.env and the shell win over them.
  try { for (const [k, v] of Object.entries((await import('./core/config.ts')).unknownEnv(cfg, sec))) process.env[k] ??= v }
  catch (e) { say(`could not export the env file's own keys: ${e}`) }
  // Kage's own Claude login (kage claude-login): sessions bill its seat. An API key in the environment would win over it.
  if (sec.claudeToken) { process.env.CLAUDE_CODE_OAUTH_TOKEN = sec.claudeToken; delete process.env.ANTHROPIC_API_KEY }
  // Keys named in config.json sessionKeys leave the environment here, before any session copies it (runtime/hold-keys.ts, #182).
  await (await import('./runtime/hold-keys.ts')).holdKeys(Object.keys(cfg.sessionKeys ?? {}), say)
  // Kage keeps its own memory (core/guards.ts memoryDirs reads the same default).
  const mem = home(cfg.harness?.memory ?? envValue(legacy, 'KAGE_MEMORY') ?? '') || `${CONF}/memory`
  if (/['"\\]/.test(mem + DIR)) { say('Move kage or KAGE_MEMORY to a path without quotes or backslashes.'); process.exit(0) }
  mkdirSync(mem, { recursive: true })
  process.env.KAGE_ENV = ENV_FILE
  process.env.KAGE_CLAUDE = claudeCommand(cfg.harness?.route ?? envValue(legacy, 'KAGE_ROUTE'))
  // Sessions work in your home folder, so they have the reach of a normal session; KAGE_CWD changes that.
  // Claude Code files transcripts by folder, so a different folder would forget every thread.
  // harness.cwd wins over a KAGE_CWD an older service unit still sets (kage service on rewrites the unit without it).
  process.env.KAGE_CWD = home(cfg.harness?.cwd ?? envValue(legacy, 'KAGE_CWD') ?? '') || process.env.KAGE_CWD || process.env.HOME!
  process.chdir(process.env.KAGE_CWD)
  try { await import('./hub/router.ts') } catch (e) {
    console.error(e)
    // An npm ci that failed or stopped midway leaves the packages behind the lock: install them, then exit 75 so the
    // supervisor starts a fresh process. Node keeps a failed lookup for the life of this one.
    if (!packagesStale(DIR)) { say('the hub could not load: read the error above'); process.exit(1) }
    say('the hub could not load and its packages are behind package-lock.json: running npm ci, then restarting')
    try { npmCi(DIR) } catch { say(`npm ci failed: run it in ${DIR} and read the error`); process.exit(1) }
    process.exit(75)
  }
}
