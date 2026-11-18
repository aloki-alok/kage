import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { addBrowserAgainLines, addBrowserLines, addBrowserPlan, extensionId, HOST, hostBrowsers, hostManifest } from '../core/browser-pair.ts'
import { findPeople, type Person } from '../core/gate.ts'
import { add, kindOf, ownerPerson, remove, type Entry, pastedId } from '../core/registry.ts'
import { registryOf, withRegistry } from '../core/config.ts'
import { readSettings, updateConfig, updateSecrets } from '../runtime/config-files.ts'
import { pauseLine, type Live } from '../core/board.ts'
import { askHub, DIR, ENV_FILE, settingsExist } from './home.ts'
import { NAME, resultLine, rowLine, kageletRows, starterFile } from '../core/kagelets.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { jobPath, kageletsDir, readKagelets, writeJob } from '../runtime/kagelet-files.ts'
import { reload, said } from './reload.ts'

const KAGELETS = kageletsDir(DIR)
const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [cmd = '', ...args] = process.argv.slice(2).map(pastedId)
const USAGE = 'Usage: kage add <person> | kage add <app id> <owner> | kage remove <person or app id> | kage list'
if (!['add', 'remove', 'list'].includes(cmd)) die(USAGE)
if (cmd !== 'list' && process.env.KAGE_CLAUDE) die(`This shell runs inside Kage, and a session cannot change who reaches Kage. The owner runs kage ${cmd} in their own terminal.`)
if (cmd === 'add' && args[0] === 'kagelet') {
  const name = args[1] ?? ''
  if (args.length !== 2 || !NAME.test(name)) die('Usage: kage add kagelet <name>, a short lowercase name: letters, digits, dashes')
  const file = jobPath(KAGELETS, name)
  if (existsSync(`${KAGELETS}/${name}`)) die(`${KAGELETS}/${name} already exists. Edit its job.md, or pick another name.`)
  try { writeJob(KAGELETS, name, starterFile()) } catch (e) { die((e as Error).message) }
  console.log(`Wrote ${file}, paused.\nFill in its thread, schedule, tools and job, then run kage start ${name}. It runs within a minute.`)
  process.exit(0)
}
if (cmd === 'add' && args[0] === 'browser') {
  if (!settingsExist()) die(`No settings in ${DIR}. Run kage setup first.`)
  const plan = addBrowserPlan({ hasToken: !!readSettings(ENV_FILE).secrets.browserToken, reinstall: args.includes('--reinstall') })
  if (!plan.newToken && !args.includes('--show-token')) { console.log(addBrowserAgainLines().join('\n')); process.exit(0) }
  const token = plan.newToken ? randomBytes(24).toString('hex') : readSettings(ENV_FILE).secrets.browserToken!
  if (plan.newToken) updateSecrets(ENV_FILE, s => ({ ...s, browserToken: token }))
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
if (!settingsExist()) die(`No settings in ${DIR}. Run kage setup first.`)
const { config, secrets } = (() => { try { return readSettings(ENV_FILE) } catch (e) { return die((e as Error).message) } })()
const now = registryOf(config)

async function slack(method: string, params: Record<string, string>) {
  const token = secrets.slack?.user
  if (!token) die(`No Slack user token saved in ${DIR}. Run kage save first.`)
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
  return await r.json() as { ok: boolean; error?: string } & Record<string, any>
}
const must = async (method: string, params: Record<string, string>) => {
  const j = await slack(method, params)
  return j.ok ? j : die(`Slack says: ${j.error}`)
}
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

async function who(query: string): Promise<{ kind: Entry['kind']; id: string; name?: string; tag?: string }> {
  const q = query.trim()
  if (kindOf(q) === 'agent') return { kind: 'agent', id: q }
  if (/^[^\s@<]+@[^\s@>]+\.[^\s@>]+$/.test(q)) {
    const j = await slack('users.lookupByEmail', { email: q })
    if (j.error === 'missing_scope') die('Slack does not let this app look people up by email (it lacks the users:read.email scope). Run kage slack upgrade, or use their @handle, name or member id.')
    if (!j.ok) die(j.error === 'users_not_found' ? `No one in this workspace has the email ${q}.` : `Slack says: ${j.error}`)
    return { kind: 'person', id: j.user.id, name: j.user.real_name }
  }
  const isId = /^<?@?[UW][A-Z0-9]{2,}>?$/.test(q)
  const found = findPeople(isId ? [] : await everyone(), q)
  if (found.length === 0) die(`No active person matches "${query}". Try their @handle, email or Slack member id. An agent is added by its app id.`)
  if (found.length > 1) die(`"${query}" matches more than one person. Run again with one of these ids:\n${found.map(p => `  ${p.id}  ${p.name}`).join('\n')}`)
  const p = found[0]!
  if (!isId) return { kind: 'person', ...p }
  if (cmd === 'remove') return { kind: 'person', id: p.id }
  const u = (await must('users.info', { user: p.id })).user
  if (u.is_bot && kindOf(u.profile?.api_app_id ?? '') === 'agent') return { kind: 'agent', id: u.profile.api_app_id, name: u.real_name, tag: p.id }
  return { kind: 'person', id: p.id, name: u.real_name }
}

const label = (e: { id: string; name?: string }) => (e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id)
const names = new Map<string, string>()
const line = (e: Entry) => (e.kind === 'person' ? `person ${label({ id: e.id, name: names.get(e.id) })}` : `agent ${e.id}${e.owner ? `, which answers to ${label({ id: e.owner, name: names.get(e.owner) })}` : ''}${e.tag ? `, tagged as ${e.tag}` : ''}`)

async function save(next: Entry[]) {
  updateConfig(ENV_FILE, c => withRegistry(c, next))
  try { for (const l of said(await reload())) console.log(l) } catch (e) { console.log((e as Error).message) }
}

if (cmd === 'list') {
  const board = await askHub<Live>({ type: 'board' }).catch(() => undefined)
  if (board?.paused) console.log(pauseLine(board.paused))
  if (!now.length) console.log('No one is listed: only you can tag Kage. Add someone: kage add <person>')
  if (args[0] !== '--ids') for (const e of now) if (e.kind === 'person') { const n = await nameOf(e.id); if (n) names.set(e.id, n) }
  const under = (owner: string, depth: number): void => {
    for (const a of now) if (a.kind === 'agent' && a.owner === owner) { console.log(`${'  '.repeat(depth)}agent ${a.id}${a.tag ? '' : '  (no tag saved, so Kage cannot address it: add it again by a mention of it)'}`); under(a.id, depth + 1) }
  }
  for (const e of now) if (e.kind === 'person') { console.log(label({ id: e.id, name: names.get(e.id) })); under(e.id, 1) }
  const loose = now.filter(e => e.kind === 'agent' && !ownerPerson(now, e.id))
  if (loose.length) console.log(`Agents not tied to a listed person: ${loose.map(e => e.id).join(', ')}\n  One with no owner counts with any listed person's token. Tie one to its owner: kage add <app id> <owner>`)
  const files = readKagelets(KAGELETS)
  if (files.length) {
    const ledgers = openLedgers(DIR)
    const t = Date.now()
    console.log(`\nKagelets Kage manages (${files.length}):`)
    for (const r of kageletRows(files, { runs: ledgers.text('runs'), costs: ledgers.text('costs'), reports: ledgers.text('reports'), now: t })) console.log(`  ${rowLine(r, t)}${r.state === 'broken' ? '' : `\n    made by ${r.by === 'kage' ? 'Kage' : 'you'}${r.why ? `: ${r.why}` : ''}. Last report: ${resultLine(r, t)}`}`)
    ledgers.close()
  }
} else if (cmd === 'add' && args.length) {
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
