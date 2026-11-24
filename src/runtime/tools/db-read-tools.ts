import { execFile } from 'node:child_process'
import { readOnlyQuery } from '../../core/db-read.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'

type Options = ToolContext['o']
type KageletRead = NonNullable<Options['dbRead']>
type Routes = NonNullable<Options['dbRoutes']>

const RULES = 'One statement, no writes, no row locks, no backslashes or dollar quotes. Rows are capped, so aggregate in SQL instead of reading raw rows.'

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
    run: args => runRead(c, name, db.command(), String(args.sql ?? ''), db.maxRows, db.timeoutMs, 'refused: no read command is set. Say so in the thread: your manager asks the owner.'),
  }
}

function routedRead(c: ToolContext, db: Routes): KageTool {
  const names = Object.keys(db.routes()).join(', ')
  return {
    name: 'db_read',
    description: `Run one read-only SQL query (SELECT or WITH ... SELECT, PostgreSQL) on one of the owner's databases (${names}) and get the rows back. Any Slack task may read, a teammate's included, with no card and no ask. ${RULES}`,
    shape: {
      channel: c.s.describe('channel attribute from the task tag'),
      thread_ts: c.s.describe('thread_ts attribute from the task tag'),
      db: c.s.describe(`the database: ${names}`),
      sql: c.s.describe('one SELECT or WITH ... SELECT statement'),
    },
    async run(args) {
      const key = `${String(args.channel)}:${String(args.thread_ts)}`, route = String(args.db ?? '')
      const name = `${route} ${key}`
      if (!c.dbReaders.has(key)) return refuse(c, name, 'only a Slack task from the owner, a teammate or an agent with an owner person reads a database, from its own thread')
      const routes = db.routes(), command = Object.hasOwn(routes, route) ? routes[route] : undefined
      if (!command) return refuse(c, name, `no read route ${route}. The owner named these: ${Object.keys(routes).join(', ')}`)
      return runRead(c, name, command, String(args.sql ?? ''), db.maxRows, undefined, '')
    },
  }
}

function refuse(c: ToolContext, name: string, why: string): Result {
  c.append('db-reads', [name, '0', '0ms', `refused: ${why}`])
  return { isError: true, text: `refused: ${why}` }
}

async function runRead(c: ToolContext, name: string, command: string | undefined, sql: string, maxRows: number, timeoutMs: number | undefined, unset: string): Promise<Result> {
  const started = Date.now()
  const done = (lines: number, outcome: string) => c.append('db-reads', [name, String(lines), `${Date.now() - started}ms`, outcome])
  if (!command) { done(0, 'refused: no read command is set'); return { isError: true, text: unset } }
  const q = readOnlyQuery(sql, maxRows)
  if ('refused' in q) { done(0, `refused: ${q.refused}`); return { isError: true, text: `refused: ${q.refused}` } }
  const timeout = timeoutMs ?? 30_000
  const r = await new Promise<{ out: string; err?: string }>(res => execFile('/bin/sh', ['-c', `${command} "$1"`, 'db_read', q.sql],
    { timeout, maxBuffer: 4 << 20, encoding: 'utf8' },
    (e, out, stderr) => res(e ? { out, err: (e as { killed?: boolean }).killed ? `the query took longer than ${timeout / 1000} s`
      : (stderr.trim() || `the read command exited with ${(e as { code?: unknown }).code}`).slice(0, 500) } : { out })))
  if (r.err) { done(0, `failed: ${r.err.split('\n')[0]}`); return { isError: true, text: `db_read failed: ${r.err}` } }
  const lines = r.out.split('\n').filter(l => l.trim()).length
  done(lines, 'ok')
  const LIMIT = 20_000
  const text = r.out.length > LIMIT ? `${r.out.slice(0, LIMIT)}\n(cut at ${LIMIT} characters: aggregate in SQL to see it all)` : r.out
  return { text: `${text || '(no rows)'}${lines >= maxRows ? `\n(may be capped at ${maxRows} rows)` : ''}` }
}
