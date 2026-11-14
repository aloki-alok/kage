// The hub's ledgers (what Kage posted, what it waits on, what each turn cost, ...) as rows in kage.db.
// The hub and every tmux pane write them, so unlike the rest of the store they have many writers:
// SQLite's lock (WAL plus a busy timeout) keeps their rows whole and in order.
// text() gives back the TSV the parsers in core/ledgers.ts and core/retro.ts already read.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { log } from '../config.ts'
import { tsvRow } from '../core/ledgers.ts'
import { eventRow, whoOf, type EventKind, type KageEvent } from '../core/events.ts'

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

      // Every grants row (only db_read is granted) is an event too, from whichever process wrote it.
      if (name === 'grants') event({ kind: cells[1] === 'granted' ? 'grant' : 'refusal', who: cells[0] ?? '', trace: '', detail: `db_read: ${cells[2] ?? ''}` })
    },
    text(name: LedgerName): string {
      try { return ledgerText(db, name) } catch (e) { log('ledger read failed', name, e); return '' }
    },
    event,
    // One UTC day (YYYY-MM-DD), in the order written.
    events: (day: string) => db.prepare('select at, kind, who, trace, chain, detail, transcript from events where at >= ? and at < ? order by id')
      .all(day, `${day}\uffff`).map(r => ({ ...r }) as KageEvent),
    // Every event before the cutoff folds into one day-summary row per day ("tool 12, run.end 3"), in one transaction.
    pruneEvents(before: string) {
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

// Which run each session key is in, so its tool calls and report land on that run's trace. In memory: a hub
// restart cuts every run anyway. fresh: a scheduled run is a run of its own, even when the last one never ended.
export function runEvents(l: Pick<Ledgers, 'event'>, newId: () => string) {
  const open = new Map<string, { trace: string; chain: string; reported: boolean }>()
  const emit = (key: string, kind: EventKind, detail: string, transcript = '') => {
    const r = open.get(key)
    if (r && kind === 'report') r.reported = true
    l.event({ kind, who: whoOf(key), trace: r?.trace ?? '', chain: r?.chain ?? '', detail, transcript })
  }
  const end = (key: string, detail: string, transcript = '') => {
    const r = open.get(key)
    if (!r) return
    emit(key, 'run.end', `${detail}, ${r.reported ? 'reported' : 'no report'}`, transcript)
    open.delete(key)
  }
  return {
    emit, end,
    start(key: string, detail: string, o: { fresh?: boolean; chain?: string } = {}) {
      if (open.has(key) && !o.fresh) return
      end(key, 'cut: no result')
      open.set(key, { trace: newId(), chain: o.chain ?? '', reported: false })
      emit(key, 'run.start', detail)
    },
  }
}
