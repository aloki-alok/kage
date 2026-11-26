import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { log } from './log.ts'
import { lastTotals, trailEvent, trailLine, tsvRow, turnCost, type Tokens } from '../core/ledgers.ts'
import { eventRow, whoOf, type EventKind, type KageEvent } from '../core/events.ts'
import { COST_FLAG } from '../core/kagelets/kagelet.ts'
import { postedEvent } from '../core/post-kinds.ts'

type LedgerName = 'flags' | 'issue-reports' | 'waiting' | 'posted' | 'prod-actions' | 'costs' | 'runs' | 'commands' | 'reports' | 'db-reads' | 'grants' | 'verdicts' | 'card-verdicts' | 'boots' | 'trust-steps' | 'trust-shadow'
const NAMES: LedgerName[] = ['waiting', 'posted', 'prod-actions', 'costs', 'runs', 'commands', 'reports', 'db-reads', 'grants', 'verdicts']
export type Ledgers = ReturnType<typeof openLedgers>

function schema(db: DatabaseSync) {
  db.exec('pragma journal_mode = wal')
  db.exec(`create table if not exists ledger (
    id integer primary key autoincrement,   -- the order rows were written in
    name text not null, at text not null,
    cells text not null                     -- JSON array: the columns after the time
  ); create index if not exists ledger_name on ledger (name, id)`)
  db.exec(`create table if not exists events (
    id integer primary key autoincrement,
    at text not null, kind text not null, who text not null, trace text not null, chain text not null,
    detail text not null, transcript text not null
  ); create index if not exists events_at on events (at)`)
  db.exec('create table if not exists ledger_imported (file text primary key)')
}

function importFile(db: DatabaseSync, dir: string, name: LedgerName, f: string, insert: StatementSync) {
  db.exec('begin immediate')
  try {
    if (!db.prepare('select 1 from ledger_imported where file = ?').get(f)) {
      for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean)) {
        const [at = '', ...cells] = line.split('\t')
        insert.run(name, at, JSON.stringify(cells))
      }
      db.prepare('insert into ledger_imported (file) values (?)').run(f)
    }
    db.exec('commit')
  } catch (e) { try { db.exec('rollback') } catch {} throw e }
  renameSync(`${dir}/${f}`, `${dir}/${f.replace('.importing-', '.imported-')}`)
}

function importTsv(db: DatabaseSync, dir: string, insert: StatementSync) {
  for (const name of NAMES) {
    const file = `${dir}/${name}.tsv`
    try { if (existsSync(file)) renameSync(file, `${file}.importing-${process.pid}-${Date.now()}`) } catch {}
    for (const f of readdirSync(dir).filter(f => f.startsWith(`${name}.tsv.importing-`))) {
      try { importFile(db, dir, name, f, insert) } catch (e) { log('ledger import failed', f, e) }
    }
  }
}

function rowEvent(name: LedgerName, cells: string[], event: (e: Parameters<typeof eventRow>[0]) => void, kind?: string) {
  const post = name === 'posted' ? postedEvent(cells, kind) : undefined
  if (post) event(post)
  if (name === 'grants') {
    const [who = '', status = '', why = '', tools = 'db_read'] = cells
    event({ kind: ['read', 'granted', 'standing'].includes(status) ? 'grant' : status === 'revoked' ? 'revoke' : 'refusal', who, trace: '', detail: `${tools}${['read', 'standing', 'revoked'].includes(status) ? ` ${status}` : ''}: ${why}` })
  }
  if (name === 'reports' && cells[0]?.startsWith(COST_FLAG)) event({ kind: 'cost-flag', who: cells[0].slice(COST_FLAG.length), trace: '', detail: cells[1] ?? '' })
}

function pruneEvents(db: DatabaseSync, cutoff: string) {
  const before = cutoff.slice(0, 10)
  db.exec('begin immediate')
  try {
    db.prepare(`insert into events (at, kind, who, trace, chain, detail, transcript)
      select day || 'T00:00:00.000Z', 'day-summary', '', '', '', group_concat(kind || ' ' || n, ', '), ''
      from (select substr(at, 1, 10) day, kind, count(*) n from events where at < ? and kind != 'day-summary' group by day, kind)
      group by day`).run(before)
    db.prepare("delete from events where at < ? and kind != 'day-summary'").run(before)
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}

export function openLedgers(dir: string, now = () => new Date().toISOString(), trail?: (line: string) => void, added?: (name: LedgerName, cells: string[]) => void) {
  const db = new DatabaseSync(`${dir}/kage.db`, { timeout: 5000 })
  schema(db)
  const insert = db.prepare('insert into ledger (name, at, cells) values (?, ?, ?)')
  const insertEvent = db.prepare('insert into events (at, kind, who, trace, chain, detail, transcript) values (?, ?, ?, ?, ?, ?, ?)')
  importTsv(db, dir, insert)

  const event = (e: Parameters<typeof eventRow>[0]) => {
    const r = eventRow(e)
    try { insertEvent.run(now(), r.kind, r.who, r.trace, r.chain, r.detail, r.transcript) } catch (err) { log('event write failed', e.kind, err) }
    trail?.(trailEvent(r))
  }
  return {
    add(name: LedgerName, cells: string[], kind?: string) {
      try { insert.run(name, now(), JSON.stringify(cells.map(c => c.replace(/[\t\r\n]+/g, ' ')))) } catch (e) { log('ledger write failed', name, e) }
      trail?.(trailLine(name, cells.map(c => c.replace(/[\t\r\n]+/g, ' '))))
      added?.(name, cells)
      rowEvent(name, cells, event, kind)
    },
    text(name: LedgerName, since?: string): string {
      try { return ledgerText(db, name, since) } catch (e) { log('ledger read failed', name, e); return '' }
    },
    event,
    events: (day: string) => eventsOn(db, day),
    eventsAfter: (id: number, limit: number) => db.prepare("select id, at, kind, who, trace, chain, detail, transcript from events where id > ? and kind != 'day-summary' order by id limit ?")
      .all(id, limit).map(r => ({ ...r }) as KageEvent & { id: number }),
    maxEventId: () => Number((db.prepare('select coalesce(max(id), 0) n from events').get() as { n: number }).n),
    pruneEvents: (cutoff: string) => pruneEvents(db, cutoff),
    close: () => db.close(),
  }
}

export const ledgerText = (db: DatabaseSync, name: LedgerName, since = '') =>
  (db.prepare('select at, cells from ledger where name = ? and at >= ? order by id').all(name, since) as { at: string; cells: string }[])
    .map(r => tsvRow([r.at, ...JSON.parse(r.cells) as string[]])).join('')

export const eventsOn = (db: DatabaseSync, day: string) =>
  db.prepare('select at, kind, who, trace, chain, detail, transcript from events where at >= ? and at < ? order by id')
    .all(day, `${day}\uffff`).map(r => ({ ...r }) as KageEvent)

export function runEvents(l: Pick<Ledgers, 'event'>, newId: () => string, clock = Date.now) {
  const open = new Map<string, { trace: string; chain: string; hops: number; reported: boolean; refused: boolean }>()
  const times = new Map<string, { at: number; posted?: number }>()
  const emit = (key: string, kind: EventKind, detail: string, transcript = ''): void => {
    if (!open.has(key) && (kind === 'tool' || kind === 'refusal' || kind === 'report')) start(key, 'next turn')
    const r = open.get(key)
    if (r && kind === 'report') r.reported = true
    if (r && kind === 'refusal') r.refused = true
    l.event({ kind, who: whoOf(key), trace: r?.trace ?? '', chain: r?.chain ?? '', detail, transcript })
  }
  const end = (key: string, detail: string, transcript = '') => {
    const r = open.get(key), t = times.get(key) ?? { at: clock() }
    if (!r) return
    emit(key, 'run.end', `${detail}, ${r.reported ? 'reported' : 'no report'}, ms=${clock() - t.at}${t.posted != null ? ` first_post_ms=${t.posted}` : ''}`, transcript)
    open.delete(key)
    times.delete(key)
  }
  function start(key: string, detail: string, o: { fresh?: boolean; chain?: string; hops?: number } = {}) {
    if (open.has(key) && !o.fresh) return
    end(key, 'cut: no result')
    open.set(key, { trace: newId(), chain: o.chain ?? '', hops: o.hops ?? 0, reported: false, refused: false })
    times.set(key, { at: clock() })
    emit(key, 'run.start', detail)
  }
  const posted = (key: string) => { const t = times.get(key); if (t && t.posted == null) t.posted = clock() - t.at }
  return { start, emit, end, posted, of: (key: string) => open.get(key) }
}

export function costRecorder(l: Pick<Ledgers, 'add' | 'text'>) {
  const totals = lastTotals(l.text('costs'))
  return (key: string, total: number, resumed: boolean, tokens?: Tokens) => {
    const usd = turnCost(totals.get(key), total, resumed)
    if (usd === undefined) return undefined
    totals.set(key, total)
    l.add('costs', [key, String(usd), String(total), ...tokens ? [tokens.input, tokens.cacheWrite, tokens.cacheRead, tokens.output, tokens.who, ...tokens.model ? [tokens.model] : []].map(String) : []])
    return usd
  }
}
