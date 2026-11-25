#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { repliesIn } from '../core/transcript.ts'
import { askHub, DIR, notRunning, TRANSCRIPTS } from './home.ts'
import { pickThread } from './pick-thread.ts'

const USAGE = 'Usage: kage thread send [--wait] [--timeout 30m] <place> <message, or - to read it from stdin>'
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }
const args = process.argv.slice(2)
const wait = args.includes('--wait')
const at = args.indexOf('--timeout')
const span = at >= 0 ? /^(\d+)([smh])$/.exec(args[at + 1] ?? '') : ['30m', '30', 'm']
if (!span) { console.error(`${USAGE}\n--timeout takes a number and s, m or h, like 90s or 30m.`); process.exit(2) }
const timeoutMs = Number(span[1]) * UNIT[span[2]!]!
const [arg = '', ...words] = args.filter((a, i) => a !== '--wait' && (at < 0 || (i !== at && i !== at + 1)))
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot speak as the owner.'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(`${DIR}/router.sock`)) notRunning()
const text = (words.length === 1 && words[0] === '-' ? readFileSync(0, 'utf8') : words.join(' ')).trim()
if (!arg || !text) { console.error(USAGE); process.exit(2) }

const { key, place } = await pickThread(arg)
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const sizeOf = (f: string) => { try { return statSync(f).size } catch { return 0 } }
const fileOf = () => { const r = db.prepare('select claude_id from sessions where key = ?').get(key) as { claude_id?: string } | undefined; return r?.claude_id ? `${TRANSCRIPTS}/${r.claude_id}.jsonl` : '' }
const startId = Number((db.prepare('select coalesce(max(id), 0) n from events').get() as { n: number }).n)
const read = new Map<string, number>()
const first = fileOf()
if (first) read.set(first, sizeOf(first))

type Answer = { ok?: true; held?: true; refused?: string }
const r: Answer = await askHub<Answer>({ type: 'tell', key, text }).catch((e: Error) => e.message === 'down' ? notRunning() : { refused: e.message })
if (!r.ok) { console.error(`Could not tell ${place}: ${r.refused}.`); process.exit(1) }
console.error(r.held ? `Told ${place}. It is open in kage thread attach, so it reads this when you quit there.` : `Told ${place}.`)
if (!wait) process.exit(0)

function newReplies(file: string) {
  if (!file) return []
  const from = read.get(file) ?? 0, size = sizeOf(file)
  if (size <= from) return []
  const chunk = readFileSync(file).subarray(from, size).toString('utf8')
  const done = chunk.lastIndexOf('\n') + 1
  read.set(file, from + Buffer.byteLength(chunk.slice(0, done)))
  return chunk.slice(0, done).split('\n').flatMap(repliesIn)
}
function step(): boolean {
  const ended = db.prepare("select transcript from events where id > ? and kind = 'run.end' and who = ? order by id limit 1").get(startId, key) as { transcript: string } | undefined
  for (const file of new Set([fileOf(), ...ended?.transcript ? [ended.transcript] : []])) {
    for (const reply of newReplies(file)) {
      console.log(reply.text)
      if (reply.asksOwner) { console.error(`${place} waits on your answer: ${reply.asksOwner}\nAnswer with kage thread send ${key} <text>.`); return true }
    }
  }
  return Boolean(ended)
}
const deadline = Date.now() + timeoutMs
while (!step()) {
  if (Date.now() > deadline) { console.error(`No end of the turn within ${span[0]}. It goes on: follow it with kage thread follow ${key}.`); process.exit(1) }
  await new Promise(res => setTimeout(res, 500))
}
