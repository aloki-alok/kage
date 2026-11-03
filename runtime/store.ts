// The hub's store: one SQLite file (Node's built-in sqlite) holding every conversation Kage has
// seen and the Claude session id working on each. The hub is its only writer.
import { DatabaseSync } from 'node:sqlite'
import { parseSessionKey, type Conversation } from '../core/conversations.ts'

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
);`

export type Store = ReturnType<typeof openStore>

export function openStore(path: string) {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec(SCHEMA)
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
    close: () => db.close(),
  }
}
