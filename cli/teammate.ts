// Lists, adds or removes the teammates who may tag Kage, then restarts the router so it
// takes effect. Open sessions resume on their next tag. Usage:
//   kage teammate list | add <name, @handle, id or mention> | remove <same>
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { findPeople, teammatesIn, withTeammates, type Person } from '../core/gate.ts'

import { ENV_FILE } from './home.ts'
const env = readFileSync(ENV_FILE, 'utf8')
const token = /^SLACK_USER_TOKEN=(.*)$/m.exec(env)?.[1]
const die = (msg: string): never => { console.error(msg); process.exit(1) }
if (!token) die(`No SLACK_USER_TOKEN in ${ENV_FILE}. Run kage save first.`)

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

// The hub reads the list when it starts. Inside a Kage session a restart would end that session
// before it could answer, so there it only says how to apply the change.
const restartHub = () => {
  if (process.env.KAGE_CLAUDE) return console.log('Saved. Kage picks it up when the owner runs kage restart in their own terminal.')
  const r = spawnSync(fileURLToPath(new URL('../setup.sh', import.meta.url)), ['restart'], { stdio: 'inherit' })
  if (r.status !== 0) console.log('The change applies at the next kage start.')
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
    restartHub()
  }
} else {
  die('Usage: kage teammate list | add <name or id> | remove <name or id>')
}
