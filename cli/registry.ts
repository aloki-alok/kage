// kage add, kage remove, kage list: who may reach Kage besides the owner (core/registry.ts). The running hub
// takes a change at once (kage reload), so no session is cut.
//   kage add <person>              a pasted mention, a Slack member id, an email, a name or an @handle
//   kage add <app id> <owner>      an agent, and who it answers to: a person, or a listed agent (its manager).
//                                  A pasted mention of the agent in place of its app id also saves its tag, so Kage can address it.
//   kage remove <person or app id> whoever answers to them goes too
//   kage list                      add --ids to skip the name lookup
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { setEnvLine } from '../core/browser.ts'
import { findPeople, type Person } from '../core/gate.ts'
import { add, kindOf, ownerPerson, registryIn, remove, withRegistry, type Entry } from '../core/registry.ts'
import { pauseLine, type Live } from '../core/board.ts'
import { askHub, DIR, ENV_FILE } from './home.ts'
import { NAME, resultLine, rowLine, kageletRows, starterFile } from '../core/kagelets.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets.ts'
import { reload, said } from './reload.ts'

const KAGELETS = kageletsDir(DIR)
const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [cmd = '', ...args] = process.argv.slice(2)
const USAGE = 'Usage: kage add <person> | kage add <app id> <owner> | kage remove <person or app id> | kage list'
if (!['add', 'remove', 'list'].includes(cmd)) die(USAGE)
// Before anything is read: a session, whoever's task it runs, never changes who reaches Kage.
if (cmd !== 'list' && process.env.KAGE_CLAUDE) die(`This shell runs inside Kage, and a session cannot change who reaches Kage. The owner runs kage ${cmd} in their own terminal.`)
// kage add kagelet <name>: a starter file, paused until its owner fills it in (core/kagelets.ts).
if (cmd === 'add' && args[0] === 'kagelet') {
  const name = args[1] ?? ''
  if (args.length !== 2 || !NAME.test(name)) die('Usage: kage add kagelet <name>, a short lowercase name: letters, digits, dashes')
  const file = `${KAGELETS}/${name}.md`
  if (existsSync(file)) die(`${file} already exists. Edit it, or pick another name.`)
  mkdirSync(KAGELETS, { recursive: true, mode: 0o700 })
  writeFileSync(file, starterFile(), { mode: 0o600, flag: 'wx' })
  console.log(`Wrote ${file}, paused.\nFill in its thread, schedule, tools and job, then run kage start ${name}. It runs within a minute.`)
  process.exit(0)
}
// kage add browser: turn Kage in Chrome on (#114). A new token each time, so running it again also cuts off an
// extension that had the old one. The token is shown once, here, for the extension's options.
if (cmd === 'add' && args[0] === 'browser') {
  if (!existsSync(ENV_FILE)) die(`No settings file at ${ENV_FILE}. Run kage setup first.`)
  const token = randomBytes(24).toString('hex')
  writeFileSync(`${ENV_FILE}.new`, setEnvLine(readFileSync(ENV_FILE, 'utf8'), 'KAGE_BROWSER_TOKEN', token), { mode: 0o600 })
  renameSync(`${ENV_FILE}.new`, ENV_FILE)
  const ext = new URL('../extension', import.meta.url).pathname
  console.log([
    `Kage in Chrome is on. Your token (shown once): ${token}`,
    '',
    '1. Run kage restart.',
    '2. In Chrome, open chrome://extensions, turn on Developer mode, click Load unpacked, and pick:',
    `   ${ext}`,
    "3. Click the Kage icon in Chrome's toolbar, paste the token, and save. It says Connected within a few seconds.",
    '4. In Slack, ask Kage: "what tabs do I have open?"',
    '',
    'Sites Kage must never read: add KAGE_BROWSER_BLOCK=bank.example.com,1password.com to the settings file.',
  ].join('\n'))
  process.exit(0)
}
if (!existsSync(ENV_FILE)) die(`No settings file at ${ENV_FILE}. Run kage setup first.`)
const env = readFileSync(ENV_FILE, 'utf8')
const now = registryIn(env)

async function slack(method: string, params: Record<string, string>) {
  const token = /^SLACK_USER_TOKEN=(.*)$/m.exec(env)?.[1]
  if (!token) die(`No SLACK_USER_TOKEN in ${ENV_FILE}. Run kage save first.`)
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
  return await r.json() as { ok: boolean; error?: string } & Record<string, any>
}
const must = async (method: string, params: Record<string, string>) => {
  const j = await slack(method, params)
  return j.ok ? j : die(`Slack says: ${j.error}`)
}
// A name for a line a person reads. The id alone when Slack does not answer.
const nameOf = async (id: string) => (await slack('users.info', { user: id }).catch(() => undefined))?.user?.real_name as string | undefined

async function everyone(): Promise<Person[]> {
  const all: Person[] = []
  let cursor = ''
  do {
    const j = await must('users.list', { limit: '200', ...(cursor && { cursor }) })
    all.push(...j.members)
    cursor = j.response_metadata?.next_cursor ?? ''
  } while (cursor)
  return all
}

// Who the words mean: an app id is an agent; a mention, member id, email, name or @handle is a person.
// A mention of an app's bot user is that app's agent.
async function who(query: string): Promise<{ kind: Entry['kind']; id: string; name?: string; tag?: string }> {
  const q = query.trim()
  if (kindOf(q) === 'agent') return { kind: 'agent', id: q }
  if (/^[^\s@<]+@[^\s@>]+\.[^\s@>]+$/.test(q)) {
    const j = await slack('users.lookupByEmail', { email: q })
    if (j.error === 'missing_scope') die('Slack does not let this app look people up by email (it lacks the users:read.email scope). Use their @handle, name or member id.')
    if (!j.ok) die(j.error === 'users_not_found' ? `No one in this workspace has the email ${q}.` : `Slack says: ${j.error}`)
    return { kind: 'person', id: j.user.id, name: j.user.real_name }
  }
  const isId = /^<?@?[UW][A-Z0-9]{2,}>?$/.test(q)
  const found = findPeople(isId ? [] : await everyone(), q)
  if (found.length === 0) die(`No active person matches "${query}". Try their @handle, email or Slack member id. An agent is added by its app id.`)
  if (found.length > 1) die(`"${query}" matches more than one person. Run again with one of these ids:\n${found.map(p => `  ${p.id}  ${p.name}`).join('\n')}`)
  const p = found[0]!
  if (!isId) return { kind: 'person', ...p }
  if (cmd === 'remove') return { kind: 'person', id: p.id }   // a listed id goes without asking Slack
  const u = (await must('users.info', { user: p.id })).user
  if (u.is_bot && kindOf(u.profile?.api_app_id ?? '') === 'agent') return { kind: 'agent', id: u.profile.api_app_id, name: u.real_name, tag: p.id }   // the mention is how Kage tags it back
  return { kind: 'person', id: p.id, name: u.real_name }
}

const label = (e: { id: string; name?: string }) => (e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id)
const names = new Map<string, string>()
const line = (e: Entry) => (e.kind === 'person' ? `person ${label({ id: e.id, name: names.get(e.id) })}` : `agent ${e.id}${e.owner ? `, which answers to ${label({ id: e.owner, name: names.get(e.owner) })}` : ''}${e.tag ? `, tagged as ${e.tag}` : ''}`)

// Write a copy, then swap it in: a crash mid-write never leaves a cut-off token file. Then the hub takes it.
async function save(next: Entry[]) {
  // The mode applies only to a file this call creates, so a copy left behind goes first.
  rmSync(`${ENV_FILE}.new`, { force: true })
  writeFileSync(`${ENV_FILE}.new`, withRegistry(env, next), { mode: 0o600, flag: 'wx' })
  renameSync(`${ENV_FILE}.new`, ENV_FILE)
  try { for (const l of said(await reload())) console.log(l) } catch (e) { console.log((e as Error).message) }
}

if (cmd === 'list') {
  // A pause holds what listed people send, so the list says so first.
  const board = await askHub<Live>({ type: 'board' }).catch(() => undefined)
  if (board?.paused) console.log(pauseLine(board.paused))
  if (!now.length) console.log('No one is listed: only you can tag Kage. Add someone: kage add <person>')
  if (args[0] !== '--ids') for (const e of now) if (e.kind === 'person') { const n = await nameOf(e.id); if (n) names.set(e.id, n) }
  const under = (owner: string, depth: number): void => {
    for (const a of now) if (a.kind === 'agent' && a.owner === owner) { console.log(`${'  '.repeat(depth)}agent ${a.id}${a.tag ? '' : '  (no tag saved, so Kage cannot address it: add it again by a mention of it)'}`); under(a.id, depth + 1) }
  }
  for (const e of now) if (e.kind === 'person') { console.log(label({ id: e.id, name: names.get(e.id) })); under(e.id, 1) }
  // Everything the tree above did not print: no owner, an owner who is not listed, or a loop made by hand.
  const loose = now.filter(e => e.kind === 'agent' && !ownerPerson(now, e.id))
  if (loose.length) console.log(`Agents not tied to a listed person: ${loose.map(e => e.id).join(', ')}\n  One with no owner counts with any listed person's token. Tie one to its owner: kage add <app id> <owner>`)
  // Kage's own kagelets: it manages them, and they answer to it.
  const files = readKagelets(KAGELETS)
  if (files.length) {
    const ledgers = openLedgers(DIR)
    const t = Date.now()
    console.log(`\nKagelets Kage manages (${files.length}):`)
    for (const r of kageletRows(files, { runs: ledgers.text('runs'), costs: ledgers.text('costs'), reports: ledgers.text('reports'), now: t })) console.log(`  ${rowLine(r, t)}${r.state === 'broken' ? '' : `\n    made by ${r.by === 'kage' ? 'Kage' : 'you'}${r.why ? `: ${r.why}` : ''}. Last report: ${resultLine(r, t)}`}`)
    ledgers.close()
  }
} else if (cmd === 'add' && args.length) {
  // An id or a mention is one word, and may be an agent followed by its owner. Anything else is a person's name, of one or more words.
  const oneWord = kindOf(args[0]!) === 'agent' || /^<?@?[UW][A-Z0-9]{2,}>?$/.test(args[0]!)
  const first = await who(oneWord ? args[0]! : args.join(' '))
  if (first.name) names.set(first.id, first.name)
  let entry: Entry
  if (first.kind === 'agent') {
    if (args.length < 2) die(`${label(first)} is an agent, and an agent answers to one owner. Run: kage add ${first.id} <its owner: a person, or a listed agent's app id>`)
    const owner = await who(args.slice(1).join(' '))
    if (owner.name) names.set(owner.id, owner.name)
    entry = { kind: 'agent', id: first.id, owner: owner.id, ...(first.tag && { tag: first.tag }) }
  } else {
    if (oneWord && args.length > 1) die(USAGE)
    entry = { kind: 'person', id: first.id }
  }
  const r = add(now, entry)
  if ('error' in r) die(`Not added: ${r.error}`)
  else if (!r.added.length) console.log(`${line(entry)} is already listed. Nothing changed.`)
  else {
    for (const e of r.added) console.log(`Added ${line(e)}.`)
    if (entry.kind === 'agent') console.log(kindOf(entry.owner!) === 'person'
      ? "A tagged post from this agent, made with its owner's token, counts as that person's task. It never counts as yours."
      : 'An agent that answers to another agent cannot task Kage from Slack yet.')
    await save(r.entries)
  }
} else if (cmd === 'remove' && args.length) {
  const target = await who(args.join(' '))
  const r = remove(now, target.id)
  if (!r.removed.length) console.log(`${label(target)} is not listed. Nothing changed.`)
  else {
    for (const e of r.removed) console.log(`Removed ${line(e)}.`)
    await save(r.entries)
  }
} else die(USAGE)
