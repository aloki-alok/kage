// The hub's entry: what launchd or systemd runs (service.sh), or `kage run` under any other supervisor.
// It uses only Node's own modules and loads router.ts last, so a bad pull that breaks the hub's code or its
// packages is still caught here: logged, counted, and after 3 starts in 10 minutes sent to the owner as a DM.
// The supervisor's rule: a non-zero exit restarts the hub, and exit 0 (kage stop, a second hub) leaves it down.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DIR = import.meta.dirname
const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
const CONF = dirname(ENV_FILE)
const say = (line: string) => console.error(`${new Date().toISOString()} hub.ts: ${line}`)

// The env file's last line for a key wins, as in the hub's own parser.
const envValue = (text: string, key: string) =>
  text.split('\n').filter(l => l.startsWith(`${key}=`)).map(l => l.slice(key.length + 1)).at(-1)

// The supervisor appends to hub.log and keeps it open, so the hub copies it aside and empties it in place.
function rotate(log: string, max = 10 * 1024 * 1024) {
  try { if (statSync(log).size <= max) return } catch { return }
  copyFileSync(log, `${log}.1`)
  truncateSync(log, 0)
}

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
async function crashLoopDm(env: string, boots: number, last: string, now: number) {
  const sentAt = `${CONF}/crash-dm-at`
  if (boots < 3 || now - Number(existsSync(sentAt) ? readFileSync(sentAt, 'utf8') : 0) < 3600) return
  try {
    const owner = (await slack('auth.test', envValue(env, 'SLACK_USER_TOKEN') ?? '')).user_id
    const text = `Kage started ${boots} times in 10 minutes, so it is probably crashing. The last lines of its log:\n\`\`\`\n${last}\n\`\`\`\nRun kage logs for more.`
    if (owner && (await slack('chat.postMessage', envValue(env, 'SLACK_BOT_TOKEN') ?? '', { channel: owner, text })).ok) writeFileSync(sentAt, String(now))
    else say('could not DM the owner about the restarts')
  } catch (e) { say(`could not DM the owner about the restarts: ${e}`) }
}

// The command that starts Claude Code in a tmux pane. A session inherits it, which is how kage commands know they run inside Kage.
function claudeCommand(env: string, mem: string) {
  let tools = ''
  for (const t of ['reply', 'edit_message', 'delete_message', 'send_file', 'message_people', 'schedule', 'unschedule', 'schedules']) tools += ` mcp__kage__${t} mcp__plugin_kage_kage__${t}`
  tools += ` --disallowedTools CronCreate CronDelete CronList --settings '{"autoMemoryDirectory":"${mem}"}'`
  // The plugin route only works once your org approves the channel, so it is opt-in: KAGE_ROUTE=plugin.
  if (envValue(env, 'KAGE_ROUTE') === 'plugin') return `claude --channels plugin:kage@kage --allowedTools${tools}`
  const mcp = JSON.stringify({ mcpServers: { kage: { command: process.execPath, args: [join(DIR, 'server.ts')] } } })
  return `claude --mcp-config '${mcp}' --allowedTools${tools} --dangerously-load-development-channels server:kage`
}

{
  if (!existsSync(ENV_FILE)) { console.error(`No ${ENV_FILE} yet. Run kage setup first.`); process.exit(0) }
  const env = readFileSync(ENV_FILE, 'utf8')
  const log = `${CONF}/hub.log`
  rotate(log)
  const last = lastLines(log)
  const now = Math.floor(Date.now() / 1000)
  const boots = countBoot(`${CONF}/boots`, now)
  say(`hub start ${boots} in the last 10 minutes`)
  await crashLoopDm(env, boots, last, now)

  // Sessions see the supervisor's environment, not your shell's. Exports they need go in session.env, which must be private.
  const sessionEnv = `${CONF}/session.env`
  if (existsSync(sessionEnv)) {
    if ((statSync(sessionEnv).mode & 0o777) === 0o600) process.loadEnvFile(sessionEnv)
    else say(`${sessionEnv} is not private, so it was skipped. Run chmod 600 on it.`)
  }
  // Kage keeps its own memory (core/guards.ts memoryDirs reads the same default).
  const mem = envValue(env, 'KAGE_MEMORY') || `${CONF}/memory`
  if (/['"\\]/.test(mem + DIR)) { say('Move kage or KAGE_MEMORY to a path without quotes or backslashes.'); process.exit(0) }
  mkdirSync(mem, { recursive: true })
  process.env.KAGE_ENV = ENV_FILE
  process.env.KAGE_CLAUDE = claudeCommand(env, mem)
  // Sessions work in your home folder, so they have the reach of a normal session; KAGE_CWD changes that.
  // Claude Code files transcripts by folder, so a different folder would forget every thread.
  process.chdir(process.env.KAGE_CWD || process.env.HOME!)
  try { await import('./router.ts') } catch (e) {
    console.error(e)
    say('the hub could not load: a bad pull, or packages out of date (npm ci)')
    process.exit(1)
  }
}
