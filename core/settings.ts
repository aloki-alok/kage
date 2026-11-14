// The env file as settings: reading it, checking it, and taking a changed file into a running hub (kage reload).
import { validName } from './gate.ts'
import { appEntry, validUserId } from './registry.ts'

export type Env = Record<string, string>
// Who may reach Kage. These two lists are the settings a running hub takes without a restart.
export type AllowLists = { teammates: string[]; apps: string[] }

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
  const notUser = teammates.findIndex(t => !validUserId(t))
  if (notUser >= 0) return { error: `KAGE_TEAMMATES has ${shown(teammates, notUser)}, which is not a Slack user id like U0123ABC` }
  // Agents: a Slack app id, or "<app id>:<owner id>" (core/registry.ts). Empty: none.
  const apps = list(env.KAGE_TRUSTED_APPS)
  const notApp = apps.findIndex(a => !appEntry(a))
  if (notApp >= 0) return { error: `KAGE_TRUSTED_APPS has ${shown(apps, notApp)}, which is not a Slack app id like A0123ABC, or an app id and its owner like A0123ABC:U0123ABC` }
  return { name, teammates, apps }
}

// What kage reload answers (runtime/config-watch.ts check).
export type Reloaded = { changed: string[]; restart: string[]; count: number } | { refused: string }
