import { DatabaseSync } from 'node:sqlite'
import type { Line } from './prompt.ts'
import type { Thread } from './decide.ts'

export type EventRow = { at: number; key: string; kind: string; outcome: string; label?: string; ms: number }
export type Store = ReturnType<typeof openStore>

export function openStore(file: string) {
  const db = new DatabaseSync(file)
  db.exec(`create table if not exists seen (id text primary key, at integer not null);
    create table if not exists threads (key text primary key, day text not null, replies integer not null, human_at integer);
    create table if not exists lines (key text not null, at integer not null, who text not null, text text not null);
    create index if not exists lines_key on lines (key, at);
    create table if not exists events (at integer not null, key text not null, kind text not null, outcome text not null, label text, ms integer not null);`)
  const q = {
    seen: db.prepare('insert or ignore into seen (id, at) values (?, ?)'),
    forget: db.prepare('delete from seen where id = ?'),
    thread: db.prepare('select day, replies, human_at from threads where key = ?'),
    save: db.prepare('insert into threads (key, day, replies, human_at) values (?, ?, ?, ?) on conflict (key) do update set day = excluded.day, replies = excluded.replies, human_at = excluded.human_at'),
    line: db.prepare('insert into lines (key, at, who, text) values (?, ?, ?, ?)'),
    history: db.prepare("select who, text from (select at, who, text from lines where key = ? and who != 'draft' order by at desc limit ?) order by at"),
    event: db.prepare('insert into events (at, key, kind, outcome, label, ms) values (?, ?, ?, ?, ?, ?)'),
    drafts: db.prepare("select key, at, text from lines where who = 'draft' order by at desc limit ?"),
    prune: [db.prepare('delete from lines where at < ?'), db.prepare('delete from seen where at < ?'), db.prepare('delete from events where at < ?')],
  }
  return {
    firstTime: (id: string, at: number) => Number(q.seen.run(id, at).changes) === 1,
    forget: (id: string) => void q.forget.run(id),
    thread(key: string): Thread | undefined {
      const r = q.thread.get(key) as { day: string; replies: number; human_at: number | null } | undefined
      return r && { day: r.day, repliesToday: r.replies, ...(r.human_at === null ? {} : { humanAt: r.human_at }) }
    },
    saveThread: (key: string, t: Thread) => void q.save.run(key, t.day, t.repliesToday, t.humanAt ?? null),
    addLine: (key: string, at: number, who: Line['who'] | 'draft', text: string) => void q.line.run(key, at, who, text),
    history: (key: string, n: number) => q.history.all(key, n) as Line[],
    event: (e: EventRow) => void q.event.run(e.at, e.key, e.kind, e.outcome, e.label ?? null, e.ms),
    drafts: (n: number) => q.drafts.all(n) as { key: string; at: number; text: string }[],
    prune: (before: number) => { for (const p of q.prune) p.run(before) },
    close: () => db.close(),
  }
}
