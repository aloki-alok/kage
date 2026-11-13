// The env file as settings: reading it, checking it, and taking a changed file into a running hub (kage reload).
import { validName } from './gate.ts'

export type Env = Record<string, string>
// Who may reach Kage. These two lists are the settings a running hub takes without a restart.
export type AllowLists = { teammates: string[]; apps: string[] }
const LISTS = { KAGE_TEAMMATES: 'teammates', KAGE_TRUSTED_APPS: 'apps' } as const

// One NAME=value per line; the last line of a name wins. Indent, spaces around "=" and quotes are dropped.
export function parseEnv(text: string): Env {
  const env: Env = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/.exec(line)
    if (m) env[m[1]!] = m[2]!
  }
  return env
}

const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean)
// A wrong list entry as the reason shows it. A long one may be a token pasted on the wrong line, so only its place is named.
const shown = (l: string[], i: number) => (l[i]!.length <= 20 ? `"${l[i]}"` : `a wrong entry ${i + 1} (too long to show)`)

// What the hub needs from the file to run, or the one line that is wrong. A reason never holds a token.
export function checkEnv(env: Env): ({ name: string } & AllowLists) | { error: string } {
  for (const k of ['SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN']) if (!env[k]) return { error: `${k} is missing` }
  const name = (env.KAGE_NAME || 'kage').toLowerCase()
  if (!validName(name)) return { error: `KAGE_NAME "${name}" must be a short lowercase word (letters, digits, dashes)` }
  // Slack user ids who may tag the bot too. Empty: only the owner.
  const teammates = list(env.KAGE_TEAMMATES)
  const notUser = teammates.findIndex(t => !/^[UW][A-Z0-9]{2,}$/.test(t))
  if (notUser >= 0) return { error: `KAGE_TEAMMATES has ${shown(teammates, notUser)}, which is not a Slack user id like U0123ABC` }
  // Slack app ids of teammates' own agents, whose posts count as that teammate's. Empty: none.
  const apps = list(env.KAGE_TRUSTED_APPS)
  const notApp = apps.findIndex(a => !/^A[A-Z0-9]{2,}$/.test(a))
  if (notApp >= 0) return { error: `KAGE_TRUSTED_APPS has ${shown(apps, notApp)}, which is not a Slack app id like A0123ABC` }
  return { name, teammates, apps }
}

export type Reloaded = { changed: string[]; restart: string[]; count: number } | { refused: string }

// kage reload: read the file again and apply the two allow lists. A file that is wrong or unreadable changes
// nothing. Every other setting was fixed when the hub started, so one that differs from the start is named as
// needing a restart, each time, until the restart happens. Values never reach the answer or the log: only names and ids.
export function reloader(o: { boot: Env; read: () => string; apply: (l: AllowLists) => void; log: (line: string) => void }) {
  const first = checkEnv(o.boot)
  let live: AllowLists = 'error' in first ? { teammates: [], apps: [] } : first
  let count = 0
  return (): Reloaded => {
    count++
    let env: Env
    try { env = parseEnv(o.read()) } catch (e) { return refuse(`the settings file cannot be read (${(e as Error).message})`) }
    const next = checkEnv(env)
    if ('error' in next) return refuse(next.error)
    const changed = Object.entries(LISTS).flatMap(([name, k]) => {
      const added = next[k].filter(x => !live[k].includes(x)), removed = live[k].filter(x => !next[k].includes(x))
      const parts = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean)
      return parts.length ? [`${name}: ${parts.join(', ')}`] : []
    })
    const restart = [...new Set([...Object.keys(o.boot), ...Object.keys(env)])].filter(k => !(k in LISTS) && o.boot[k] !== env[k]).sort()
    live = { teammates: next.teammates, apps: next.apps }
    o.apply(live)
    o.log(`reload ${count}: ${changed.join('; ') || 'no list changed'}${restart.length ? `; needs a restart: ${restart.join(', ')}` : ''}`)
    return { changed, restart, count }
  }
  function refuse(why: string): Reloaded {
    o.log(`reload ${count} refused: ${why}`)
    return { refused: why }
  }
}
