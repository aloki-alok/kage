// Lists, adds or removes the teammates who may tag Kage, then restarts the router so it
// takes effect. Running sessions keep going. Usage (via setup.sh):
//   ./setup.sh teammate list | add <name, @handle, id or mention> | remove <same>
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findPeople, teammatesIn, withTeammates, type Person } from './logic.ts'

const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
const env = readFileSync(ENV_FILE, 'utf8')
const token = /^SLACK_USER_TOKEN=(.*)$/m.exec(env)?.[1]
const die = (msg: string): never => { console.error(msg); process.exit(1) }
if (!token) die(`No SLACK_USER_TOKEN in ${ENV_FILE}. Run ./setup.sh save first.`)

async function slack(method: string, params: Record<string, string>) {
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
  const j = await r.json() as { ok: boolean; error?: string } & Record<string, any>
  if (!j.ok) die(`Slack says: ${j.error}`)
  return j
}

async function everyone(): Promise<Person[]> {
  const all: Person[] = []
  let cursor = ''
  do {
    const j = await slack('users.list', { limit: '200', ...(cursor && { cursor }) })
    all.push(...j.members)
    cursor = j.response_metadata?.next_cursor ?? ''
  } while (cursor)
  return all
}

async function resolve(query: string) {
  const people = /^<?@?[UW][A-Z0-9]{2,}>?$/.test(query.trim()) ? [] : await everyone()
  const found = findPeople(people, query)
  if (found.length === 0) die(`No active person matches "${query}". Try their @handle or Slack member id.`)
  if (found.length > 1) die(`"${query}" matches more than one person. Run again with one of these ids:\n${found.map(p => `  ${p.id}  ${p.name}`).join('\n')}`)
  const p = found[0]!
  if (p.name === p.id) p.name = (await slack('users.info', { user: p.id })).user.real_name || p.id
  return p
}

// The router reads the list when it starts; its tmux loop starts it again within 5 s.
function restartRouter() {
  try {
    const pid = readFileSync(`${dirname(ENV_FILE)}/status`, 'utf8').split(' ')[3]!
    // The status file outlives the router; never kill a pid that is now some other program.
    if (!execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).includes('router.js')) throw new Error('not the router')
    process.kill(Number(pid))
    console.log('Restarted the router; it is back in about 10 s. Running sessions keep going.')
  } catch {
    console.log('Kage is not running; the change applies at the next ./start.sh.')
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const query = rest.join(' ')
const now = teammatesIn(env)
if (cmd === 'list') {
  if (!now.length) console.log('No teammates: only you can tag Kage.')
  for (const id of now) console.log(`${id}  ${(await slack('users.info', { user: id })).user.real_name}`)
} else if ((cmd === 'add' || cmd === 'remove') && query) {
  const p = await resolve(query)
  const next = cmd === 'add' ? [...new Set([...now, p.id])] : now.filter(id => id !== p.id)
  if (next.length === now.length) {
    console.log(`${p.name} (${p.id}) is ${cmd === 'add' ? 'already' : 'not'} a teammate.`)
  } else {
    // Write a copy, then swap it in: a crash mid-write never leaves a cut-off token file.
    writeFileSync(`${ENV_FILE}.new`, withTeammates(env, next), { mode: 0o600 })
    renameSync(`${ENV_FILE}.new`, ENV_FILE)
    console.log(`${cmd === 'add' ? 'Added' : 'Removed'} ${p.name} (${p.id}).`)
    restartRouter()
  }
} else {
  die('Usage: ./setup.sh teammate list | add <name or id> | remove <name or id>')
}
