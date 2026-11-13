// The hub's store: one SQLite file (Node's built-in sqlite) holding every conversation Kage has
// seen, the Claude session id working on each, every message heard (the inbox), and what connectors
// keep across a restart (state). The hub is the only writer of these tables. tmux panes also write the ledger table in the same file (runtime/ledger.ts).
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseSessionKey, type Conversation } from '../core/conversations.ts'
import type { Schedule } from '../core/cron.ts'

const SCHEMA = `
create table if not exists conversations (
  key text primary key,          -- sessionKey(): agent, conversation and lane
  connector text not null, chat text not null, thread text, kind text not null, agent_dm integer not null default 0,
  place text not null,           -- what people read: "#general", "DM with Kage"
  first_seen integer not null, last_seen integer not null
);
create table if not exists sessions (
  key text primary key,          -- the same key; kept for good so a thread always resumes its own session
  claude_id text not null
);
create table if not exists schedules (
  id text primary key,
  key text not null,             -- the thread whose session runs it
  cron text not null, prompt text not null, recurring integer not null,
  from_owner integer not null,   -- each run gets the trust of the task that asked for it
  created integer not null, last_fired integer not null default 0,
  ends integer                   -- null: runs until cancelled
);
-- Every message the hub hears, written before the source is acknowledged: a crash after the
-- ack replays it on the next start, and a redelivery of the same source id is a duplicate.
create table if not exists inbox (
  source text primary key,       -- slack:<channel>:<ts>, github:<delivery>, mail:<message-id>, wa:<id>
  connector text not null,
  at integer not null,
  payload text,                  -- the raw event until it is handled, then null: other people's text does not stay
  delivered integer not null default 0,   -- 1: a session has it and its turn has not ended (runtime/limit-pause.ts)
  held_until integer             -- set: its turn hit the usage limit, or it came in the pause; it replays at this time
);
-- What a connector keeps across a restart, one JSON value per name: afk, github-threads, mail-threads.
create table if not exists state (
  name text primary key,
  value text not null
);
create table if not exists trust (
  key text primary key,          -- a thread is owner-trusted while every task it got came from the owner
  owner_only integer not null
);`

export type Store = ReturnType<typeof openStore>
// What a connector gets from the store: take is false for a source id heard before. A null payload
// records the id only, for a source that resends by itself until handled (SQS): such a source
// checks has() first and takes the id after handling.
// What a connector keeps across a restart. undefined removes it.
export type Saved = { load(name: string): unknown; save(name: string, value: unknown): void }
export type Inbox = { take(source: string, connector: string, payload: string | null): boolean; handled(source: string): void; has(source: string): boolean }

const toSchedule = (r: Record<string, any>): Schedule => ({
  id: r.id, key: r.key, cron: r.cron, prompt: r.prompt, recurring: r.recurring === 1, fromOwner: r.from_owner === 1,
  created: Number(r.created), lastFired: Number(r.last_fired), ...(r.ends != null && { ends: Number(r.ends) }),
})

// One thread's schedules (every thread's with no key), read without opening the store for writing: for a session's own process,
// while the hub stays the only writer. Nothing yet (no store, no table) reads as none.
export function schedulesIn(path: string, key?: string): Schedule[] {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try { return (db.prepare(`select * from schedules ${key === undefined ? '' : 'where key = ?'} order by created`).all(...(key === undefined ? [] : [key])) as Record<string, any>[]).map(toSchedule) } finally { db.close() }
  } catch { return [] }
}

export function openStore(path: string) {
  const db = new DatabaseSync(path)
  // The ledger table in this file has other writers (tmux panes, runtime/ledger.ts): wait for their lock, don't fail.
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000')
  db.exec(SCHEMA)
  // A store from before the usage-limit pause gains its two inbox columns. Older code ignores them.
  const inboxCols = new Set((db.prepare('pragma table_info(inbox)').all() as { name: string }[]).map(c => c.name))
  if (!inboxCols.has('delivered')) db.exec('alter table inbox add column delivered integer not null default 0')
  if (!inboxCols.has('held_until')) db.exec('alter table inbox add column held_until integer')
  const upsertConversation = db.prepare(`insert into conversations (key, connector, chat, thread, kind, agent_dm, place, first_seen, last_seen)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (key) do update set place = excluded.place, last_seen = max(last_seen, excluded.last_seen)`)
  const insertConversation = db.prepare(`insert into conversations (key, connector, chat, thread, kind, agent_dm, place, first_seen, last_seen)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (key) do nothing`)
  const upsertSession = db.prepare('insert into sessions (key, claude_id) values (?, ?) on conflict (key) do update set claude_id = excluded.claude_id')
  const insertSession = db.prepare('insert into sessions (key, claude_id) values (?, ?) on conflict (key) do nothing')
  const row = (c: Conversation) => [c.connector, c.chat, c.thread ?? null, c.kind, c.agentDm ? 1 : 0] as const

  return {
    // A message arrived in this conversation.
    // Threads imported from threads.json carry their key as the name until a lookup names them.
    unnamed(): { key: string; chat: string }[] {
      return (db.prepare("select key, chat from conversations where place = key and connector = 'slack'").all() as { key: string; chat: string }[])
        .map(r => ({ key: r.key, chat: r.chat }))
    },
    name(key: string, place: string) { db.prepare('update conversations set place = ? where key = ?').run(place, key) },
    seen(key: string, c: Conversation, place: string, now: number) {
      upsertConversation.run(key, ...row(c), place, now, now)
    },
    conversation(key: string) {
      const r = db.prepare('select * from conversations where key = ?').get(key) as Record<string, any> | undefined
      if (!r) return undefined
      const conversation: Conversation = { connector: r.connector, chat: r.chat, kind: r.kind, ...(r.thread !== null && { thread: r.thread }), ...(r.agent_dm && { agentDm: true as const }) }
      return { key: r.key as string, conversation, place: r.place as string, firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen) }
    },
    sessions(): Record<string, string> {
      return Object.fromEntries((db.prepare('select key, claude_id from sessions').all() as { key: string; claude_id: string }[]).map(r => [r.key, r.claude_id]))
    },
    // The dispatcher's whole map, written in one transaction.
    saveSessions(map: Record<string, string>) {
      db.exec('begin')
      try { for (const [k, id] of Object.entries(map)) upsertSession.run(k, id); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
    },
    forget(key: string) {
      db.prepare('delete from sessions where key = ?').run(key)
    },
    // One-time move from threads.json. Rows already in the store win; keys it can't read are reported.
    importThreads(map: Record<string, string>, botDm: string, now: number) {
      const skipped: string[] = []
      let imported = 0
      db.exec('begin')
      try {
        for (const [k, id] of Object.entries(map)) {
          const parsed = parseSessionKey(k, botDm)
          if (!parsed) { skipped.push(k); continue }
          insertConversation.run(k, ...row(parsed.conversation), k, now, now)
          insertSession.run(k, id)
          imported++
        }
        db.exec('commit')
      } catch (e) { db.exec('rollback'); throw e }
      return { imported, skipped }
    },
    // Repeating checks the hub runs (core/cron.ts). Adding an id that exists changes nothing.
    addSchedule(s: Schedule) {
      db.prepare('insert into schedules (id, key, cron, prompt, recurring, from_owner, created, last_fired, ends) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing')
        .run(s.id, s.key, s.cron, s.prompt, s.recurring ? 1 : 0, s.fromOwner ? 1 : 0, s.created, s.lastFired, s.ends ?? null)
    },
    schedules: (): Schedule[] => (db.prepare('select * from schedules order by created').all() as Record<string, any>[]).map(toSchedule),
    fired(id: string, at: number) { db.prepare('update schedules set last_fired = ? where id = ?').run(at, id) },
    // Only the thread that owns a schedule may remove it; the hub drops expired ones with key undefined.
    removeSchedule(id: string, key?: string): boolean {
      const r = key === undefined ? db.prepare('delete from schedules where id = ?').run(id) : db.prepare('delete from schedules where id = ? and key = ?').run(id, key)
      return Number(r.changes) > 0
    },
    trust(key: string): boolean | undefined {
      const r = db.prepare('select owner_only from trust where key = ?').get(key) as { owner_only: number } | undefined
      return r && r.owner_only === 1
    },
    // A task reached the thread. It stays owner-trusted only while every task came from the owner.
    // `known`: the thread had a session before trust was recorded, so its history is unknown.
    noteTask(key: string, fromOwner: boolean, known: boolean) {
      this.setTrust(key, (this.trust(key) ?? !known) && fromOwner)
    },
    setTrust(key: string, ownerOnly: boolean) {
      db.prepare('insert into trust (key, owner_only) values (?, ?) on conflict (key) do update set owner_only = excluded.owner_only').run(key, ownerOnly ? 1 : 0)
    },
    // Durable intake (the inbox table). false: this source id was taken before, so it is a redelivery.
    take(source: string, connector: string, payload: string | null, now: number): boolean {
      return Number(db.prepare('insert into inbox (source, connector, at, payload) values (?, ?, ?, ?) on conflict (source) do nothing').run(source, connector, now, payload).changes) > 0
    },
    has: (source: string) => db.prepare('select 1 from inbox where source = ?').get(source) !== undefined,
    handled(source: string) { db.prepare('update inbox set payload = null where source = ?').run(source) },
    // A session took the message. Its text stays until the turn ends, so a turn that hits the usage limit can replay it.
    // false: no such message with its text still here.
    delivered: (source: string) => Number(db.prepare('update inbox set delivered = 1 where source = ? and payload is not null').run(source).changes) > 0,
    // Held by the usage limit until `until` (runtime/limit-pause.ts). false: no such message with its text still here.
    hold: (source: string, until: number) => Number(db.prepare('update inbox set held_until = ? where source = ? and payload is not null').run(until, source).changes) > 0,
    held(): { source: string; connector: string; payload: string; at: number; until: number }[] {
      return (db.prepare('select source, connector, payload, at, held_until from inbox where payload is not null and held_until is not null order by at').all() as Record<string, any>[])
        .map(r => ({ source: r.source, connector: r.connector, payload: r.payload, at: Number(r.at), until: Number(r.held_until) }))
    },
    // The hold is over: the message is about to replay, as one just taken.
    release(source: string) { db.prepare('update inbox set held_until = null, delivered = 0 where source = ?').run(source) },
    // At the start: messages taken but never delivered (a crash came between the ack and the task). Ones older
    // than `since` are let go (a reply hours late does more harm than none), so they never come back. One a
    // session had when the hub stopped is let go too: its turn may be half done. A held one waits for its reset time.
    unhandled(since: number): { source: string; connector: string; payload: string; at: number }[] {
      db.prepare('update inbox set payload = null where payload is not null and held_until is null and (at < ? or delivered = 1)').run(since)
      return (db.prepare('select source, connector, payload, at from inbox where payload is not null and held_until is null order by at').all() as Record<string, any>[])
        .map(r => ({ source: r.source, connector: r.connector, payload: r.payload, at: Number(r.at) }))
    },
    // Redeliveries come within minutes (Slack) or days (SQS, GitHub's manual redeliver), so a week of ids is enough.
    prune(before: number) { db.prepare('delete from inbox where payload is null and at < ?').run(before) },
    load(name: string): unknown {
      const r = db.prepare('select value from state where name = ?').get(name) as { value: string } | undefined
      return r && JSON.parse(r.value)
    },
    save(name: string, value: unknown) {
      if (value === undefined) db.prepare('delete from state where name = ?').run(name)
      else db.prepare('insert into state (name, value) values (?, ?) on conflict (name) do update set value = excluded.value').run(name, JSON.stringify(value))
    },
    // One-time move from the old JSON files. The row is written before the file is renamed, so a crash
    // between them leaves a file that the next start only clears: a row already saved wins.
    importState(files: Record<string, string>) {
      for (const [name, file] of Object.entries(files)) {
        if (!existsSync(file)) continue
        try {
          const value = JSON.parse(readFileSync(file, 'utf8'))
          db.prepare('insert into state (name, value) values (?, ?) on conflict (name) do nothing').run(name, JSON.stringify(value))
          renameSync(file, `${file}.imported-${Date.now()}`)
        } catch (e) { console.error(`kage: could not import ${file}, left in place:`, e) }
      }
    },
    close: () => db.close(),
  }
}
