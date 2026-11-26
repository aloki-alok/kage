#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { triggerLine } from '../core/tripwire.ts'
import { pausedJobsIn, schedulesIn } from '../runtime/store.ts'
import { askHub, DIR, notRunning, placeNamer } from './home.ts'
import { pickThread } from './pick-thread.ts'

const USAGE = `Usage:
  kage schedule add [--thread <place>] (--cron "<5 fields>" | --channel <id> [--match <regex>] [--no-bots] | --hook) --prompt <text, or -> [--once] [--probe <command> [--ignore <regex>]... [--reads <file>]... [--writes <file>]...] [--model <model>] [--needs <mcp tool>]...
  kage schedule view <id>
  kage schedule rm|pause|resume <id>
  kage schedule tune <id> [--cron "<5 fields>"] [--probe <command>] [--ignore <regex>]... [--reads <file>]... [--writes <file>]... [--needs <mcp tool>]...`
const usage = (why?: string): never => { console.error(`${why ? `${why}\n` : ''}${USAGE}`); process.exit(2) }
const many = { type: 'string', multiple: true } as const
const one = { type: 'string' } as const
const FLAGS = { thread: one, cron: one, channel: one, match: one, 'no-bots': { type: 'boolean' }, hook: { type: 'boolean' }, prompt: one, once: { type: 'boolean' }, probe: one, ignore: many, reads: many, writes: many, model: one, needs: many } as const

const [verb = '', ...rest] = process.argv.slice(2)
let parsed: ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>
try { parsed = parseArgs({ args: rest, options: FLAGS, allowPositionals: true }) } catch (e) { usage((e as Error).message) }
const { values: v, positionals } = parsed!
const probeParts = { ...v.ignore && { ignore: v.ignore }, ...v.reads && { reads: v.reads }, ...v.writes && { writes: v.writes } }

if (verb === 'view') view(positionals[0] ?? usage())
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session changes jobs with its own schedule tools. The owner runs kage schedule in their own terminal.'); process.exit(1) }
const question = verb === 'add' ? await addQuestion() : verb === 'tune' ? tuneQuestion() : ['rm', 'pause', 'resume'].includes(verb) && positionals.length === 1 ? { action: verb, id: positionals[0] } : usage()
if (!existsSync(`${DIR}/router.sock`)) notRunning()
type Answer = { text?: string; refused?: string }
const r: Answer = await askHub<Answer>({ type: 'job', ...question }).catch((e: Error) => e.message === 'down' ? notRunning() : { refused: 'Kage did not answer' })
if (typeof r.text !== 'string') { console.error(`Not done: ${r.refused}.`); process.exit(1) }
console.log(r.text)

async function addQuestion() {
  if (positionals.length) usage(`kage schedule add takes flags only, and ${positionals[0]} is not one.`)
  if (!v.prompt) usage('A job needs --prompt: what each run does.')
  const prompt = (v.prompt === '-' ? readFileSync(0, 'utf8') : v.prompt ?? '').trim()
  const key = v.thread ? (await pickThread(v.thread, false)).key : 'dm'
  const spec = {
    ...v.cron && { cron: v.cron }, prompt, ...v.once && { recurring: false },
    ...v.probe && { probe: { command: v.probe, ...probeParts } },
    ...v.channel && { on_channel: { channel: v.channel, ...v.match && { match: v.match }, ...v['no-bots'] && { bots: false } } },
    ...v.hook && { hook: true }, ...v.model && { model: v.model }, ...v.needs && { needs: v.needs },
  }
  return { action: 'add', key, spec }
}

function tuneQuestion() {
  if (positionals.length !== 1) usage('kage schedule tune takes one job id.')
  const change = { ...v.cron && { cron: v.cron }, ...v.probe && { command: v.probe }, ...probeParts, ...v.needs && { needs: v.needs } }
  if (!Object.keys(change).length) usage('Give what changes: --cron, --probe, --ignore, --reads, --writes or --needs.')
  return { action: 'tune', id: positionals[0], change }
}

function view(id: string): never {
  const db = `${DIR}/kage.db`
  const paused = pausedJobsIn(db).find(s => s.id === id)
  const s = schedulesIn(db).find(x => x.id === id) ?? paused
  if (!s) { console.error(`No job ${id}. kage schedule list shows them.`); process.exit(1) }
  console.log(`${s.id}  ${placeNamer()(s.key)}  ${s.cron}${s.recurring ? '' : ', once'}${paused ? ', paused' : ''}${s.model ? `, on ${s.model}` : ''}`)
  if (s.trigger) console.log(`  ${triggerLine(s.trigger)}`)
  console.log(`\n${s.prompt}\n\nLast runs`)
  const ev = new DatabaseSync(db, { readOnly: true })
  const runs = ev.prepare(`select s.at, e.detail from events s left join events e on e.trace = s.trace and e.kind = 'run.end'
    where s.kind = 'run.start' and s.detail = ? order by s.id desc limit 10`).all(`scheduled ${id}`) as { at: string; detail: string | null }[]
  ev.close()
  if (!runs.length) console.log('  none yet')
  for (const r of runs) console.log(`  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.detail ?? 'running'}`)
  process.exit(0)
}
