// The hub's ledgers (what Kage posted, what it waits on, what each turn cost, ...) as rows in kage.db.
// The hub and every tmux pane write them, so unlike the rest of the store they have many writers:
// SQLite's lock (WAL plus a busy timeout) keeps their rows whole and in order.
// text() gives back the TSV the parsers in core/ledgers.ts and core/retro.ts already read.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { log } from '../config.ts'
import { tsvRow } from '../core/ledgers.ts'

export type LedgerName = 'waiting' | 'posted' | 'prod-actions' | 'costs' | 'runs' | 'commands' | 'reports'
const NAMES: LedgerName[] = ['waiting', 'posted', 'prod-actions', 'costs', 'runs', 'commands', 'reports']
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

  return {
    // A ledger is a side record: a failed write is logged, never allowed to block a task or a reply.
    add(name: LedgerName, cells: string[]) {
      try { insert.run(name, now(), JSON.stringify(cells.map(c => c.replace(/[\t\r\n]+/g, ' ')))) } catch (e) { log('ledger write failed', name, e) }
    },
    text(name: LedgerName): string {
      try {
        return (db.prepare('select at, cells from ledger where name = ? order by id').all(name) as { at: string; cells: string }[])
          .map(r => tsvRow([r.at, ...JSON.parse(r.cells) as string[]])).join('')
      } catch (e) { log('ledger read failed', name, e); return '' }
    },
    close: () => db.close(),
  }
}
