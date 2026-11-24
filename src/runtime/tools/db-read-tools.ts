import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readGate, readOnlyQuery, turnAskers } from '../../core/db-read.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'

type Options = ToolContext['o']
type KageletRead = NonNullable<Options['dbRead']>
type Routes = NonNullable<Options['dbRoutes']>
type Ran = { result: Result; rows: number; outcome: string }
type Why = (stderr: string, code: unknown) => string

const RULES = 'One statement, no writes, no row locks, no backslashes or dollar quotes. Rows are capped, so aggregate in SQL instead of reading raw rows.'
const LIMIT = 20_000
const SHOWN_ERROR = /^(ERROR|DETAIL|HINT|LINE \d+):/

export function dbReadTools(c: ToolContext): KageTool[] {
  const { o } = c
  if (o.kagelet) return o.dbRead ? [kageletRead(c, o.kagelet, o.dbRead)] : []
  return !o.dreaming && o.dbRoutes && Object.keys(o.dbRoutes.routes()).length ? [routedRead(c, o.dbRoutes)] : []
}

function kageletRead(c: ToolContext, name: string, db: KageletRead): KageTool {
  return {
    name: 'db_read',
    description: `Run one read-only SQL query (SELECT or WITH ... SELECT, PostgreSQL) and get the rows back. ${RULES}`,
    shape: { sql: c.s.describe('one SELECT or WITH ... SELECT statement') },
    async run(args) {
      const started = Date.now()
      const done = (lines: number, outcome: string) => c.append('db-reads', [name, String(lines), `${Date.now() - started}ms`, outcome])
      const command = db.command()
      if (!command) { done(0, 'refused: no read command is set'); return { isError: true, text: 'refused: no read command is set. Say so in the thread: your manager asks the owner.' } }
      const ran = await runRead(command, String(args.sql ?? ''), db.maxRows, db.timeoutMs, (stderr, code) => stderr.trim() || `the read command exited with ${code}`)
      done(ran.rows, ran.outcome)
      return ran.result
    },
  }
}

const queryError: Why = (stderr, code) => stderr.split('\n').filter(l => SHOWN_ERROR.test(l)).join('\n') || `the read route exited with ${code}`

function routedRead(c: ToolContext, db: Routes): KageTool {
  const names = () => Object.keys(db.routes()).join(', ')
  return {
    name: 'db_read',
    description: `Run one read-only SQL query (SELECT or WITH ... SELECT, PostgreSQL) on one of the owner's databases (${names()}) and get the rows back. The owner may read any of them, and a teammate may read one the owner already said yes to. For any other read, post an ask first. ${RULES}`,
    shape: {
      channel: c.s.describe('channel attribute from the task tag'),
      thread_ts: c.s.describe('thread_ts attribute from the task tag'),
      db: c.s.describe(`the database: ${names()}`),
      sql: c.s.describe('one SELECT or WITH ... SELECT statement'),
    },
    async run(args) {
      const key = `${String(args.channel)}:${String(args.thread_ts)}`, route = String(args.db ?? ''), sql = String(args.sql ?? '')
      const owner = c.ownerNow(key), turn = turnAskers(c.o.turn?.() ?? [], c.o.botDm())
      const who = owner ? 'owner' : [...new Set(turn.map(t => t.teammate ?? 'owner'))].join(',') || 'unknown'
      const note = (rows: number, ms: number, outcome: string) => {
        c.append('db-reads', [who, route, createHash('sha256').update(sql.trim()).digest('hex').slice(0, 16), String(rows), `${ms}ms`, outcome])
        c.o.event?.('tool', `db_read ${outcome.split(':')[0]} rows=${rows}`)
      }
      const routes = db.routes(), command = Object.hasOwn(routes, route) ? routes[route] : undefined
      if (!command) { note(0, 0, 'refused'); return refusal(`no read route ${route}. The owner named these: ${names()}`) }
      const mode = c.o.trust?.mode() ?? 'off'
      const verdict = readGate({ turn, owner, route, mode, lines: c.o.trust?.lines() ?? [] })
      if (verdict.would) c.o.event?.('trust', `${mode} ${verdict.would}`)
      if (!verdict.read) { note(0, 0, 'refused'); return refusal(verdict.why) }
      for (const [i, line] of (verdict.lines ?? []).entries()) c.append('trust-steps', [key, who.split(',')[i] ?? who, 'prod-read', route, line])
      const started = Date.now()
      const ran = await runRead(command, sql, db.maxRows, undefined, queryError)
      note(ran.rows, Date.now() - started, ran.outcome.startsWith('refused') ? 'refused' : ran.outcome.startsWith('failed') ? 'failed' : 'ok')
      return ran.result
    },
  }
}

const refusal = (why: string): Result => ({ isError: true, text: `refused: ${why}` })

async function runRead(command: string, sql: string, maxRows: number, timeoutMs: number | undefined, why: Why): Promise<Ran> {
  const q = readOnlyQuery(sql, maxRows)
  if ('refused' in q) return { result: refusal(q.refused), rows: 0, outcome: `refused: ${q.refused}` }
  const timeout = timeoutMs ?? 30_000
  const r = await new Promise<{ out: string; err?: string }>(res => execFile('/bin/sh', ['-c', `${command} "$1"`, 'db_read', q.sql],
    { timeout, maxBuffer: 4 << 20, encoding: 'utf8' },
    (e, out, stderr) => res(e ? { out, err: (e as { killed?: boolean }).killed ? `the query took longer than ${timeout / 1000} s` : why(stderr, (e as { code?: unknown }).code).slice(0, 500) } : { out })))
  if (r.err) return { result: { isError: true, text: `db_read failed: ${r.err}` }, rows: 0, outcome: `failed: ${r.err.split('\n')[0]}` }
  const rows = r.out.split('\n').filter(l => l.trim()).length
  const text = r.out.length > LIMIT ? `${r.out.slice(0, LIMIT)}\n(cut at ${LIMIT} characters: aggregate in SQL to see it all)` : r.out
  return { result: { text: `${text || '(no rows)'}${rows >= maxRows ? `\n(may be capped at ${maxRows} rows)` : ''}` }, rows, outcome: 'ok' }
}
