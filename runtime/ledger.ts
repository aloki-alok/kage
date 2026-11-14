// The hub's ledgers (what Kage posted, what it waits on, what each turn cost, ...) as rows in kage.db.
// The hub and every tmux pane write them, so unlike the rest of the store they have many writers:
// SQLite's lock (WAL plus a busy timeout) keeps their rows whole and in order.
// text() gives back the TSV the parsers in core/ledgers.ts and core/retro.ts already read.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { log } from '../config.ts'
import { lastTotals, tsvRow, turnCost } from '../core/ledgers.ts'
import { eventRow, whoOf, type EventKind, type KageEvent } from '../core/events.ts'
import { COST_FLAG } from '../core/kagelets.ts'

export type LedgerName = 'waiting' | 'posted' | 'prod-actions' | 'costs' | 'runs' | 'commands' | 'reports' | 'db-reads' | 'grants'
const NAMES: LedgerName[] = ['waiting', 'posted', 'prod-actions', 'costs', 'runs', 'commands', 'reports', 'db-reads', 'grants']
export type Ledgers = ReturnType<typeof openLedgers>

export function openLedgers(dir: string, now = () => new Date().toISOString()) {
  const db = new DatabaseSync(`${dir}/kage.db`)
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000')
  db.exec(`create table if not exists ledger (
    id integer primary key autoincrement,   -- the order rows were written in
    name text not null, at text not null,
    cells text not null                     -- JSON array: the columns after the time
  ); create index if not exists ledger_name on ledger (name, id)`)
  const insert = db.prepare('insert into ledger (name, at, cells) values (?, ?, ?)')
  // The event log (core/events.ts): its own columns, so the dream job can group without parsing.
  db.exec(`create table if not exists events (
    id integer primary key autoincrement,
    at text not null, kind text not null, who text not null, trace text not null, chain text not null,
    detail text not null, transcript text not null
  ); create index if not exists events_at on events (at)`)
  const insertEvent = db.prepare('insert into events (at, kind, who, trace, chain, detail, transcript) values (?, ?, ?, ?, ?, ?, ?)')

  // <name>.tsv from before this table moves in once, safe against a crash and two processes at once:
  //   1. rename it to a unique .importing-<pid>-<time> name: only one process wins the rename;
  //   2. copy its rows and a marker for that name in one transaction: a replay after a crash skips it;
  //   3. rename it to .imported-<...>. A crash between any two steps is picked up on the next open.
  // A pane still on old code may write a fresh <name>.tsv later; it gets its own unique name.
  db.exec('create table if not exists ledger_imported (file text primary key)')
  for (const name of NAMES) {
    const file = `${dir}/${name}.tsv`
    try { if (existsSync(file)) renameSync(file, `${file}.importing-${process.pid}-${Date.now()}`) } catch {}
    for (const f of readdirSync(dir).filter(f => f.startsWith(`${name}.tsv.importing-`))) {
      try {
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
      } catch (e) { log('ledger import failed', f, e) }
    }
  }

  // A side record too: a failed write is logged, never thrown.
  const event = (e: Parameters<typeof eventRow>[0]) => {
    const r = eventRow(e)
    try { insertEvent.run(now(), r.kind, r.who, r.trace, r.chain, r.detail, r.transcript) } catch (err) { log('event write failed', e.kind, err) }
  }
  return {
    // A ledger is a side record: a failed write is logged, never allowed to block a task or a reply.
    add(name: LedgerName, cells: string[]) {
      try { insert.run(name, now(), JSON.stringify(cells.map(c => c.replace(/[\t\r\n]+/g, ' ')))) } catch (e) { log('ledger write failed', name, e) }
      // Every grants row is an event too, from whichever process wrote it: read (Kage's grant), granted (a card),
      // standing (a standing approval), revoked or refused. A row from before tiers has no tools cell: it was db_read.
      // So is the hub's cost flag (cost:<name>).
      if (name === 'grants') {
        const [who = '', status = '', why = '', tools = 'db_read'] = cells
        event({ kind: ['read', 'granted', 'standing'].includes(status) ? 'grant' : status === 'revoked' ? 'revoke' : 'refusal', who, trace: '', detail: `${tools}${['read', 'standing', 'revoked'].includes(status) ? ` ${status}` : ''}: ${why}` })
      }
      if (name === 'reports' && cells[0]?.startsWith(COST_FLAG)) event({ kind: 'cost-flag', who: cells[0].slice(COST_FLAG.length), trace: '', detail: cells[1] ?? '' })
    },
    text(name: LedgerName): string {
      try { return ledgerText(db, name) } catch (e) { log('ledger read failed', name, e); return '' }
    },
    event,
    // One UTC day (YYYY-MM-DD), in the order written.
    events: (day: string) => eventsOn(db, day),
    // Every event of a day before the cutoff's folds into one day-summary row per day ("tool 12, run.end 3"), in one transaction.
    // The cutoff drops to its day's midnight, so an hourly prune never folds part of a day.
    pruneEvents(cutoff: string) {
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
    },
    close: () => db.close(),
  }
}

// One ledger as TSV, from any handle on kage.db: kage top and kage logs read it with a read-only one.
export const ledgerText = (db: DatabaseSync, name: LedgerName) =>
  (db.prepare('select at, cells from ledger where name = ? order by id').all(name) as { at: string; cells: string }[])
    .map(r => tsvRow([r.at, ...JSON.parse(r.cells) as string[]])).join('')

// One UTC day's events, from any handle on kage.db: kage top and kage logs read them with a read-only one.
export const eventsOn = (db: DatabaseSync, day: string) =>
  db.prepare('select at, kind, who, trace, chain, detail, transcript from events where at >= ? and at < ? order by id')
    .all(day, `${day}\uffff`).map(r => ({ ...r }) as KageEvent)

// Which run each session key is in, so its tool calls and report land on that run's trace. In memory: a hub
// restart cuts every run anyway. fresh: a scheduled run is a run of its own, even when the last one never ended.
export function runEvents(l: Pick<Ledgers, 'event'>, newId: () => string) {
  const open = new Map<string, { trace: string; chain: string; hops: number; reported: boolean; refused: boolean }>()
  const emit = (key: string, kind: EventKind, detail: string, transcript = ''): void => {
    // A task sent mid-turn is read by the next turn, after the first one's end: its first call opens its run.
    if (!open.has(key) && (kind === 'tool' || kind === 'refusal' || kind === 'report')) start(key, 'next turn')
    const r = open.get(key)
    if (r && kind === 'report') r.reported = true
    if (r && kind === 'refusal') r.refused = true
    l.event({ kind, who: whoOf(key), trace: r?.trace ?? '', chain: r?.chain ?? '', detail, transcript })
  }
  const end = (key: string, detail: string, transcript = '') => {
    const r = open.get(key)
    if (!r) return
    emit(key, 'run.end', `${detail}, ${r.reported ? 'reported' : 'no report'}`, transcript)
    open.delete(key)
  }
  // chain, hops: a kagelet message's run (runtime/kagelets.ts), which the hub starts only in an idle session.
  function start(key: string, detail: string, o: { fresh?: boolean; chain?: string; hops?: number } = {}) {
    if (open.has(key) && !o.fresh) return
    end(key, 'cut: no result')
    open.set(key, { trace: newId(), chain: o.chain ?? '', hops: o.hops ?? 0, reported: false, refused: false })
    emit(key, 'run.start', detail)
  }
  // of: the open run, which the chain router (runtime/kagelets.ts) reads and gives a chain id.
  return { start, emit, end, of: (key: string) => open.get(key) }
}

// What each turn cost (core/ledgers.ts turnCost): one costs row per result whose total grew. `kage cost`, the
// kagelet caps and `kage logs` read them. Returns the turn's cost, undefined when there is none to record.
export function costRecorder(l: Pick<Ledgers, 'add' | 'text'>) {
  const totals = lastTotals(l.text('costs'))
  return (key: string, total: number, resumed: boolean) => {
    const usd = turnCost(totals.get(key), total, resumed)
    if (usd === undefined) return undefined
    totals.set(key, total)
    l.add('costs', [key, String(usd), String(total)])
    return usd
  }
}
