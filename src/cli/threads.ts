#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { boardAnswer } from '../core/board.ts'
import { askHub, DIR } from './home.ts'
import { outputFlags, printJson } from './output.ts'

const out = outputFlags(process.argv.slice(2))
if (out.args.length) { console.error('Usage: kage thread list [--json]'); process.exit(2) }
if (!existsSync(`${DIR}/kage.db`)) { console.error(`No ${DIR}/kage.db yet: start Kage first.`); process.exit(3) }
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const saved = db.prepare(`select s.key, coalesce(c.place, s.key) as place, c.last_seen as lastSeen from sessions s
  left join conversations c using (key) order by c.last_seen desc nulls last`).all() as { key: string; place: string; lastSeen: number | null }[]
db.close()
const board = existsSync(`${DIR}/router.sock`) ? boardAnswer(await askHub<unknown>({ type: 'board' }).catch(() => undefined)) : undefined
const live = new Map(board && 'live' in board ? board.live.live.map(t => [t.key, t.state]) : [])
const rows = saved.map(r => ({ key: r.key, place: r.place, state: live.get(r.key) ?? 'idle', lastSeen: r.lastSeen === null ? null : new Date(r.lastSeen).toISOString() }))
if (out.json) printJson(rows, out.jq)
else if (!rows.length) console.log('No threads yet.')
else {
  const width = (f: (r: typeof rows[number]) => string) => Math.max(...rows.map(r => f(r).length))
  const pw = width(r => r.place), kw = width(r => r.key)
  for (const r of rows) console.log(`${r.place.padEnd(pw)}  ${r.key.padEnd(kw)}  ${r.state.padEnd(8)}  ${r.lastSeen?.slice(0, 16).replace('T', ' ') ?? ''}`.trimEnd())
}
if (board && 'refused' in board) console.error(`Live state left out: ${board.refused}.`)
