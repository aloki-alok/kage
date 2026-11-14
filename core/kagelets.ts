// Kagelets (#57): one file each in the kagelets folder, run on a schedule in a side lane of its thread, at
// teammate trust, with only the tools its grant names. A kagelet approves nothing: what needs approval it says in
// its thread, where its manager (this Kage) and the human owner read it.
import { nextRun, parseCron } from './cron.ts'
import { slackLinkKey } from './conversations.ts'
import { clockTime, whenLabel } from './board.ts'
import { spendSince } from './ledgers.ts'

// A kagelet's name, which is also its file name: no dots or slashes, so it never leaves the folder.
export const NAME = /^[a-z][a-z0-9-]{0,30}$/

// Who made it, from its file: the owner (by hand, or by asking Kage) or Kage on its own. A hand-written file is the owner's.
export type Maker = 'owner' | 'kage'
export type Kagelet = { name: string; key: string; link: string; cron: string; tools: string[]; job: string; paused: boolean; by: Maker; why: string; resumed?: number }

// Flat front matter (key: value lines between --- lines), then the job.
export function parseKagelet(name: string, text: string): Kagelet | { error: string } {
  if (!NAME.test(name)) return { error: `the file name "${name}" must be a short lowercase name: letters, digits, dashes` }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { error: 'it needs front matter between --- lines: thread, schedule, tools' }
  const head = new Map(m[1]!.split('\n').map(l => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(x => !!x).map(x => [x[1]!, x[2]!.trim()]))
  const link = head.get('thread') ?? ''
  const thread = slackLinkKey(link)
  if (!thread) return { error: 'thread must be a Slack message link ("Copy link" in Slack)' }
  const cron = head.get('schedule') ?? ''
  try { parseCron(cron) } catch { return { error: `schedule must be a cron line like "0 9 * * 1-5", not "${cron}"` } }
  const job = m[2]!.trim()
  if (!job) return { error: 'the job, below the front matter, is empty' }
  const tools = (head.get('tools') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  // Checked on every read, so a file that says by: kage cannot hold it even when written by hand.
  if (head.get('by') === 'kage' && tools.includes(DB_READ)) return { error: `a kagelet Kage made on its own cannot hold ${DB_READ}: only the owner grants it` }
  return { name, key: `${thread}#side-kagelet-${name}`, link, cron, tools, job, paused: isPaused(head.get('paused')),
    by: head.get('by') === 'kage' ? 'kage' : 'owner', why: head.get('why') ?? '',
    ...(Date.parse(head.get('resumed') ?? '') >= 0 && { resumed: Date.parse(head.get('resumed')!) }) }
}

// Fails closed: any value but none, no or false pauses it, so a typo never starts a kagelet.
const isPaused = (v = '') => !['', 'no', 'false'].includes(v.toLowerCase())

// Pause or resume by the paused line in the front matter, so the file stays the one place a kagelet is set.
// now: a resume also stamps its time, so the daily cost cap counts only what it spends after it.
export function setPaused(text: string, paused: boolean, now?: number) {
  const m = /^(---\r?\n)([\s\S]*?\r?\n)(---)/.exec(text)
  if (!m) return text
  if (!paused && !/^\s*paused:/m.test(m[2]!)) return text
  let head = m[2]!.replace(/^\s*paused:.*\r?\n/gm, '')
  if (!paused && now !== undefined) head = `${head.replace(/^\s*resumed:.*\r?\n/gm, '')}resumed: ${new Date(now).toISOString()}\n`
  return `${m[1]}${head}${paused ? 'paused: yes\n' : ''}${text.slice(m[1]!.length + m[2]!.length)}`
}

// What kage add kagelet writes: paused, with a thread line that does not parse, so nothing runs until it is filled in.
export const starterFile = () => `---
thread: paste the Slack link of the thread it posts in ("Copy link" on a message there)
schedule: 0 9 * * 1-5
tools: WebSearch, WebFetch
paused: yes
---
Say what to check, where, and what to post in the thread. For example: every weekday at 9, read https://status.example.com and post a three-line summary.
`

// The grant name for the database tool (runtime/kage-tools.ts). Only the owner grants it, by hand in the file.
export const DB_READ = 'db_read'

// What a kagelet made on its own may be granted: the v1 web tools, never an MCP tool. Only the owner widens it.
export const DEFAULT_GRANT = ['WebSearch', 'WebFetch']

// The file the manager's tool writes. Refused with the reason when it would not run, would be granted a tool v1
// cannot grant, or Kage made it and asks for more than DEFAULT_GRANT.
export function kageletFile(f: { thread: string; schedule: string; tools: string[]; job: string; by: Maker; why: string; paused?: boolean }): string | { error: string } {
  // One line each, so no value can add a front matter line of its own (a second tools or paused line).
  for (const [k, v] of Object.entries({ thread: f.thread, schedule: f.schedule, why: f.why, tool: f.tools.join(',') })) if (/[\r\n]/.test(v)) return { error: `the ${k} must be one line` }
  const bad = f.tools.find(t => !grantable(t))
  if (bad) return { error: `a kagelet can be granted only web tools, MCP tools and ${DB_READ}, not ${bad}. A wider grant is the owner's call.` }
  const wide = f.by === 'kage' && f.tools.find(t => !DEFAULT_GRANT.includes(t))
  if (wide) return { error: `a kagelet Kage makes on its own gets only ${DEFAULT_GRANT.join(' and ')}, not ${wide}. Ask the owner to grant it.` }
  const text = `---\nthread: ${f.thread}\nschedule: ${f.schedule}\ntools: ${f.tools.join(', ')}\nby: ${f.by}\nwhy: ${f.why}\n${f.paused ? 'paused: yes\n' : ''}---\n${f.job.trim()}\n`
  const sp = parseKagelet('check', text)
  return 'error' in sp ? sp : text
}

export type Report = { at: number; summary: string; needs?: string }
// costToday: since midnight, or since its last resume today.
export type KageletRow = { name: string; state: 'runs' | 'paused' | 'broken'; error?: string; key?: string; link?: string; cron?: string; tools: string[]; lastRun?: number; next?: number; costToday: number; result?: Report; by?: Maker; why?: string }
// One row per file for kage list, kage top and the manager. runs, costs and reports are the ledgers (core/ledgers.ts).
export function kageletRows(files: { name: string; text: string }[], o: { runs: string; costs: string; reports?: string; now: number }): KageletRow[] {
  const results = new Map<string, Report>()
  for (const l of (o.reports ?? '').split('\n')) {
    const [when = '', name = '', summary = '', needs = ''] = l.split('\t')
    if (name) results.set(name, { at: Date.parse(when), summary, ...(needs && { needs }) })
  }
  const midnight = new Date(o.now).setHours(0, 0, 0, 0)
  const last = new Map<string, number>()
  for (const l of o.runs.split('\n')) {
    const [when = '', id = ''] = l.split('\t')
    // spec- is the id from before the rename (#77): its old runs still count.
    const name = id.startsWith('kagelet-') ? id.slice(8) : id.startsWith('spec-') ? id.slice(5) : ''
    if (name) last.set(name, Date.parse(when))
  }
  return [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f): KageletRow => {
    const sp = parseKagelet(f.name, f.text)
    if ('error' in sp) return { name: f.name, state: 'broken', error: sp.error, tools: [], costToday: 0 }
    const next = sp.paused ? undefined : nextRun(sp.cron, new Date(o.now), 366 * 24 * 3600_000)?.getTime()
    return {
      name: sp.name, state: sp.paused ? 'paused' : 'runs', key: sp.key, link: sp.link, cron: sp.cron, tools: sp.tools,
      ...(last.has(sp.name) && { lastRun: last.get(sp.name) }), ...(next !== undefined && { next }), costToday: spendSince(o.costs, Math.max(midnight, sp.resumed ?? 0)).find(s => s.key === sp.key)?.usd ?? 0,
      ...(results.has(sp.name) && { result: results.get(sp.name) }), by: sp.by, why: sp.why,
    }
  })
}

export function rowLine(r: KageletRow, now: number) {
  if (r.state === 'broken') return `${r.name.padEnd(16)} does not run: ${r.error}`
  return [r.name.padEnd(16), r.state.padEnd(6), r.cron!.padEnd(15), `last ${r.lastRun ? clockTime(r.lastRun, now) : 'never'}`.padEnd(14),
    `next ${whenLabel(r.next, now)}`.padEnd(14), `$${r.costToday.toFixed(2)} today`].join(' ')
}

export const resultLine = (r: KageletRow, now: number) => !r.result ? 'no report yet'
  : `${clockTime(r.result.at, now)} ${r.result.needs ? `needs: ${r.result.needs} (${r.result.summary})` : r.result.summary}`

// Of Kage's own tools, a kagelet has only those for its thread, whatever its grant says: the rest act as the
// owner (message_people, away), outlive the run (schedule) or need the owner (log_prod_write).
const THREAD_TOOLS = ['reply', 'edit_message', 'delete_message', 'report'].map(t => `mcp__kage__${t}`)
// What a grant may name: web tools and outside MCP tools, an allowlist so a new built-in tool stays out. No file,
// shell or agent tool, granted or not: one could rewrite the kagelet's own grant or read the env file with the
// tokens. ponytail: a file grant needs a sandboxed work folder first.
const grantable = (t: string) => t === DB_READ || t === 'WebFetch' || t === 'WebSearch' || (t.startsWith('mcp__') && !t.startsWith('mcp__kage__') && !t.startsWith('mcp__plugin_kage_'))

// The grant only shrinks: a tool outside it is denied.
export function grantRefusal(tool: string, grant: string[], input: Record<string, unknown> = {}) {
  if (THREAD_TOOLS.includes(tool)) return undefined
  if (tool === `mcp__kage__${DB_READ}`) return grant.includes(DB_READ) ? undefined : `${DB_READ} is outside this kagelet's grant. Only the owner grants it.`
  if (!grantable(tool)) return `A kagelet can be granted only web and MCP tools, not ${tool}. Say in the thread what you needed: your manager decides.`
  if (tool === 'WebFetch' && !/^https?:\/\//i.test(String(input.url ?? ''))) return 'A kagelet fetches only http and https addresses.'
  return grant.includes(tool) ? undefined
    : `${tool} is outside this kagelet's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
}
