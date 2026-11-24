import { DatabaseSync } from 'node:sqlite'
import type { TrustLine } from '../core/trust.ts'

const TABLE = `
create table if not exists trust_lines (
  n integer primary key autoincrement,
  who text not null, kind text not null, reach text not null,
  answer text not null, once integer not null, link text not null, at integer not null,
  state text not null
);`

type NewLine = Pick<TrustLine, 'who' | 'kind' | 'reach' | 'answer' | 'once' | 'link'>

const toLine = (r: Record<string, any>): TrustLine => ({
  id: `T${r.n}`, who: r.who, kind: r.kind, reach: r.reach, answer: r.answer, once: r.once === 1, link: r.link, at: new Date(Number(r.at)).toISOString(), state: r.state,
})

export function ensureTrustTable(db: DatabaseSync) { db.exec(TABLE) }

export function trustLinesOf(db: DatabaseSync) {
  const insert = (l: NewLine, now: number) =>
    db.prepare("insert into trust_lines (who, kind, reach, answer, once, link, at, state) values (?, ?, ?, ?, ?, ?, ?, 'live')")
      .run(l.who, l.kind, l.reach, l.answer, l.once ? 1 : 0, l.link, now)
  const number = (id: string) => /^T(\d+)$/.exec(id)?.[1]
  return {
    addTrustLine(l: NewLine, now: number): string { return `T${insert(l, now).lastInsertRowid}` },
    trustLines: (): TrustLine[] => (db.prepare('select * from trust_lines order by n').all() as Record<string, any>[]).map(toLine),
    revokeTrust(id: string): boolean {
      const n = number(id)
      return !!n && Number(db.prepare("update trust_lines set state = 'revoked' where n = ? and state != 'revoked'").run(n).changes) > 0
    },
  }
}

export function trustLinesIn(path: string): TrustLine[] {
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
    try { return (db.prepare('select * from trust_lines order by n').all() as Record<string, any>[]).map(toLine) } finally { db.close() }
  } catch { return [] }
}
