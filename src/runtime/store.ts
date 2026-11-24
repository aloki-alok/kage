import { existsSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isJobLane, parseSessionKey, threadOfJobLane, type Conversation } from '../core/conversations.ts'
import type { Schedule } from '../core/cron.ts'
import type { JobState, Trigger } from '../core/tripwire.ts'
import type { KageletMessage, MessageState } from '../core/kagelets/message.ts'
import { ensureTrustTable, trustLinesOf } from './trust-store.ts'

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
-- Every message one kagelet sends another (#93, core/kagelets/message.ts), written before it is delivered, so a
-- crash replays it. The text goes once it is read or failed, like the inbox's payload.
create table if not exists messages (
  message_id text primary key,   -- the dedupe key: the same id is never stored twice
  at integer not null, sender text not null, recipient text not null,
  state text not null,           -- queued, delivered, read, failed
  why text not null default '',  -- why it failed
  tried integer,                 -- when a run first took it: its age counts from then
  envelope text not null         -- the message as JSON
);
create table if not exists trust (
  key text primary key,          -- a thread is owner-trusted while every task it got came from the owner
  owner_only integer not null
);
create table if not exists relay_allow (
  key text primary key           -- a thread the owner approved for the SSM relay (#161), whatever its trust
);`

export type Store = ReturnType<typeof openStore>
export type Saved = { load(name: string): unknown; save(name: string, value: unknown): void }
export type Inbox = { take(source: string, connector: string, payload: string | null): boolean; handled(source: string): void; has(source: string): boolean }

const toSchedule = (r: Record<string, any>): Schedule => ({
  id: r.id, key: r.key, cron: r.cron, prompt: r.prompt, recurring: r.recurring === 1, fromOwner: r.from_owner === 1,
  created: Number(r.created), lastFired: Number(r.last_fired), ...(r.ends != null && { ends: Number(r.ends) }), ...(r.lane === 1 && { lane: true as const }),
  ...(r.trigger != null && { trigger: JSON.parse(r.trigger) }), ...(r.needs != null && { needs: JSON.parse(r.needs) }), ...(r.model != null && { model: r.model }),
})

export function schedulesIn(path: string, key?: string): Schedule[] {
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
    try { return (db.prepare(`select * from schedules ${key === undefined ? '' : 'where key = ?'} order by created`).all(...(key === undefined ? [] : [threadOfJobLane(key)])) as Record<string, any>[]).map(toSchedule) } finally { db.close() }
  } catch { return [] }
}

export function missingToolsIn(path: string): Map<string, string[]> {
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
    try {
      const rows = db.prepare('select id, job_state from schedules where job_state is not null').all() as { id: string; job_state: string }[]
      return new Map(rows.map(r => [r.id, (JSON.parse(r.job_state) as JobState).missing ?? []] as const).filter(([, m]) => m.length))
    } finally { db.close() }
  } catch { return new Map() }
}

export function openStore(path: string) {
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('pragma journal_mode = wal')
  db.exec(SCHEMA)
  migrate(db)
  ensureTrustTable(db)
  return { ...conversationsOf(db), ...schedulesOf(db), ...trustOf(db), ...trustLinesOf(db), ...inboxOf(db), ...messagesOf(db), ...stateOf(db), close: () => db.close() }
}

function migrate(db: DatabaseSync) {
  const inboxCols = new Set((db.prepare('pragma table_info(inbox)').all() as { name: string }[]).map(c => c.name))
  const scheduleCols = new Set((db.prepare('pragma table_info(schedules)').all() as { name: string }[]).map(c => c.name))
  if (!scheduleCols.has('lane')) db.exec('alter table schedules add column lane integer')
  if (!scheduleCols.has('trigger')) db.exec('alter table schedules add column trigger text')
  if (!scheduleCols.has('job_state')) db.exec('alter table schedules add column job_state text')
  if (!scheduleCols.has('needs')) db.exec('alter table schedules add column needs text')
  if (!scheduleCols.has('model')) db.exec('alter table schedules add column model text')
  if (!inboxCols.has('delivered')) db.exec('alter table inbox add column delivered integer not null default 0')
  if (!inboxCols.has('held_until')) db.exec('alter table inbox add column held_until integer')
}

function conversationsOf(db: DatabaseSync) {
  const upsertConversation = db.prepare(`insert into conversations (key, connector, chat, thread, kind, agent_dm, place, first_seen, last_seen)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (key) do update set place = excluded.place, last_seen = max(last_seen, excluded.last_seen)`)
  const insertConversation = db.prepare(`insert into conversations (key, connector, chat, thread, kind, agent_dm, place, first_seen, last_seen)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (key) do nothing`)
  const upsertSession = db.prepare('insert into sessions (key, claude_id) values (?, ?) on conflict (key) do update set claude_id = excluded.claude_id')
  const insertSession = db.prepare('insert into sessions (key, claude_id) values (?, ?) on conflict (key) do nothing')
  const row = (c: Conversation) => [c.connector, c.chat, c.thread ?? null, c.kind, c.agentDm ? 1 : 0] as const
  return {
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
  saveSessions(map: Record<string, string>) {
    db.exec('begin')
    try { for (const [k, id] of Object.entries(map)) upsertSession.run(k, id); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
  },
  forget(key: string) {
    db.prepare('delete from sessions where key = ?').run(key)
  },
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
  }
}

function schedulesOf(db: DatabaseSync) {
  return {
  addSchedule(s: Schedule) {
    db.prepare('insert into schedules (id, key, cron, prompt, recurring, from_owner, created, last_fired, ends, lane, trigger, needs, model) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing')
      .run(s.id, s.key, s.cron, s.prompt, s.recurring ? 1 : 0, s.fromOwner ? 1 : 0, s.created, s.lastFired, s.ends ?? null, s.lane ? 1 : null, s.trigger ? JSON.stringify(s.trigger) : null, s.needs?.length ? JSON.stringify(s.needs) : null, s.model ?? null)
  },
  schedules: (): Schedule[] => (db.prepare('select * from schedules order by created').all() as Record<string, any>[]).map(toSchedule),
  tuneSchedule(id: string, cron: string, trigger: Trigger, resetBaseline: boolean) {
    db.prepare('update schedules set cron = ?, trigger = ? where id = ?').run(cron, JSON.stringify(trigger), id)
    if (resetBaseline) { const { fp: _f, last: _l, ...kept } = this.jobState(id); this.setJobState(id, kept) }
  },
  setPrompt(id: string, prompt: string) { db.prepare('update schedules set prompt = ? where id = ?').run(prompt, id) },
  fired(id: string, at: number) { db.prepare('update schedules set last_fired = ? where id = ?').run(at, id) },
  jobState(id: string): JobState {
    const r = db.prepare('select job_state from schedules where id = ?').get(id) as { job_state: string | null } | undefined
    return r?.job_state ? JSON.parse(r.job_state) : { fails: 0 }
  },
  setNeeds(id: string, needs: string[]) { db.prepare('update schedules set needs = ? where id = ?').run(needs.length ? JSON.stringify(needs) : null, id) },
  setJobState(id: string, state: JobState) { db.prepare('update schedules set job_state = ? where id = ?').run(JSON.stringify(state), id) },
  moveSchedule(id: string, from: string, to: string, fromOwner: boolean): boolean {
    return Number(db.prepare('update schedules set key = ?, from_owner = ? where id = ? and key = ?').run(to, fromOwner ? 1 : 0, id, from).changes) > 0
  },
  removeSchedule(id: string, key?: string): boolean {
    const r = key === undefined ? db.prepare('delete from schedules where id = ?').run(id) : db.prepare('delete from schedules where id = ? and key = ?').run(id, key)
    return Number(r.changes) > 0
  },
  }
}

function trustOf(db: DatabaseSync) {
  return {
  trust(key: string): boolean | undefined {
    const r = db.prepare('select owner_only from trust where key = ?').get(threadOfJobLane(key)) as { owner_only: number } | undefined
    return r && r.owner_only === 1
  },
  relayAllowed: (): string[] => (db.prepare('select key from relay_allow order by key').all() as { key: string }[]).map(r => r.key),
  setRelayAllow(key: string, on: boolean) {
    if (on) db.prepare('insert into relay_allow (key) values (?) on conflict (key) do nothing').run(key)
    else db.prepare('delete from relay_allow where key = ?').run(key)
  },
  relayOk(key: string): boolean {
    return this.trust(key) === true || db.prepare('select 1 from relay_allow where key = ?').get(threadOfJobLane(key)) !== undefined
  },
  noteTask(key: string, fromOwner: boolean, known: boolean) {
    if (isJobLane(key)) return
    this.setTrust(key, (this.trust(key) ?? !known) && fromOwner)
  },
  setTrust(key: string, ownerOnly: boolean) {
    db.prepare('insert into trust (key, owner_only) values (?, ?) on conflict (key) do update set owner_only = excluded.owner_only').run(key, ownerOnly ? 1 : 0)
  },
  }
}

function inboxOf(db: DatabaseSync) {
  return {
  take(source: string, connector: string, payload: string | null, now: number): boolean {
    return Number(db.prepare('insert into inbox (source, connector, at, payload) values (?, ?, ?, ?) on conflict (source) do nothing').run(source, connector, now, payload).changes) > 0
  },
  has: (source: string) => db.prepare('select 1 from inbox where source = ?').get(source) !== undefined,
  handled(source: string) { db.prepare('update inbox set payload = null where source = ?').run(source) },
  untake(source: string) { db.prepare('delete from inbox where source = ?').run(source) },
  delivered: (source: string) => Number(db.prepare('update inbox set delivered = 1 where source = ? and payload is not null').run(source).changes) > 0,
  hold: (source: string, until: number) => Number(db.prepare('update inbox set held_until = ? where source = ? and payload is not null').run(until, source).changes) > 0,
  held(): { source: string; connector: string; payload: string; at: number; until: number }[] {
    return (db.prepare('select source, connector, payload, at, held_until from inbox where payload is not null and held_until is not null order by at').all() as Record<string, any>[])
      .map(r => ({ source: r.source, connector: r.connector, payload: r.payload, at: Number(r.at), until: Number(r.held_until) }))
  },
  release(source: string) { db.prepare('update inbox set held_until = null, delivered = 0 where source = ?').run(source) },
  unhandled(since: number): { source: string; connector: string; payload: string; at: number }[] {
    db.prepare('update inbox set payload = null where payload is not null and held_until is null and (at < ? or delivered = 1)').run(since)
    return (db.prepare('select source, connector, payload, at from inbox where payload is not null and held_until is null order by at').all() as Record<string, any>[])
      .map(r => ({ source: r.source, connector: r.connector, payload: r.payload, at: Number(r.at) }))
  },
  prune(before: number) {
    db.prepare('delete from inbox where payload is null and at < ?').run(before)
    db.prepare('delete from messages where at < ?').run(before)
  },
  }
}

function messagesOf(db: DatabaseSync) {
  const dropText = (id: string) => {
    const r = db.prepare('select envelope from messages where message_id = ?').get(id) as { envelope: string } | undefined
    if (!r) return
    const m = JSON.parse(r.envelope) as KageletMessage
    db.prepare('update messages set envelope = ? where message_id = ?').run(JSON.stringify({ ...m, parts: m.parts.map(p => p.kind === 'text' ? { ...p, text: '' } : p) }), id)
  }
  const messageState = (id: string, state: MessageState, why = '') => {
    const moved = db.prepare("update messages set state = ?, why = ? where message_id = ? and state not in ('read', 'failed')").run(state, why, id).changes > 0
    if (moved && (state === 'read' || state === 'failed')) dropText(id)
  }
  return {
  putMessage(m: KageletMessage, now: number) {
    return db.prepare("insert into messages (message_id, at, sender, recipient, state, envelope) values (?, ?, ?, ?, 'queued', ?) on conflict (message_id) do nothing")
      .run(m.messageId, now, m.from, m.to, JSON.stringify(m)).changes > 0
  },
  messageState,
  handed(id: string, now: number) { db.prepare("update messages set state = 'delivered', tried = coalesce(tried, ?) where message_id = ? and state not in ('read', 'failed')").run(now, id) },
  unread(): { message: KageletMessage; state: MessageState; at: number; tried?: number }[] {
    return (db.prepare("select envelope, state, at, tried from messages where state in ('queued', 'delivered') order by at").all() as Record<string, any>[])
      .map(r => ({ message: JSON.parse(r.envelope), state: r.state, at: Number(r.at), ...(r.tried != null && { tried: Number(r.tried) }) }))
  },
  }
}

function stateOf(db: DatabaseSync) {
  return {
  load(name: string): unknown {
    const r = db.prepare('select value from state where name = ?').get(name) as { value: string } | undefined
    return r && JSON.parse(r.value)
  },
  save(name: string, value: unknown) {
    if (value === undefined) db.prepare('delete from state where name = ?').run(name)
    else db.prepare('insert into state (name, value) values (?, ?) on conflict (name) do update set value = excluded.value').run(name, JSON.stringify(value))
  },
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
  }
}

export const kageletMessages = (db: DatabaseSync, name: string, limit = 20) =>
  (db.prepare('select at, sender, recipient, state, why, envelope from messages where sender = ? or recipient = ? order by at desc limit ?').all(name, name, limit) as Record<string, any>[])
    .map(r => ({ at: Number(r.at), from: r.sender as string, to: r.recipient as string, state: r.state as MessageState, why: r.why as string,
      text: ((JSON.parse(r.envelope) as KageletMessage).parts.find(p => p.kind === 'text') as { text: string } | undefined)?.text ?? '' }))
