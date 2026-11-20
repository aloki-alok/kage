import { execFile } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { log } from '../runtime/log.ts'
import { selfReview } from '../core/ledgers.ts'
import { chatText, dreamDue, dreamTask, threadsSince, type DreamLesson, type DreamLimits } from '../core/dream.ts'
import { applyLessons } from '../runtime/dream-lessons.ts'
import { dreamInput, dreamsDue, kageletDreamTask } from '../core/kagelets/memory.ts'
import { kageletRows } from '../core/kagelets/kagelet.ts'
import type { Conversation, Lane } from '../core/conversations.ts'
import type { Task } from '../core/task.ts'
import { readKagelets } from '../runtime/kagelets/files.ts'
import type { kageletMemory } from '../runtime/kagelets/memory.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import { snapshotMemory } from '../runtime/memory-snapshot.ts'
import { canPushToKage } from '../runtime/repo-access.ts'
import type { Store } from '../runtime/store.ts'
import { taskAsOther, taskAsOwner } from '../core/gate.ts'

const readFile = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const DAY = 24 * 3600_000

export function dreams(o: {
  dir: string; code: string; title: string; botDm: string
  mem: { own: string; owner: string }; project: string
  kagelets: string; kmem: ReturnType<typeof kageletMemory>; hasSdk: boolean
  store: Store; ledgers: Ledgers; placeOf: (key: string) => string
  paused: () => boolean; quiet: (now: number) => boolean
  deliver: (c: Conversation, task: Task, place: string, lane: Lane) => string | undefined
  toSession: (key: string, task: Task) => string | undefined
  limits: () => DreamLimits
}) {
  const lastDay = (now: number) => [new Date(now - DAY), new Date(now)].flatMap(t => o.ledgers.events(t.toISOString().slice(0, 10)))
  const DREAMT = `${o.dir}/dream-sent`, KDREAMT = 'kagelet-dream-last', THREADS = 'dream-threads'
  const ownsRepo = canPushToKage(args => new Promise((ok, no) => execFile('gh', args, { timeout: 15_000 }, (e, out) => e ? no(e) : ok(out))))
  return {
    async dream(now: number) {
      const last = Number(readFile(DREAMT).trim()) || undefined
      if (o.paused() || !dreamDue(now, last, o.quiet(now))) return
      const snap = snapshotMemory(o.mem.own, now)
      const since = Math.max(last ?? 0, now - DAY)
      const file = (id: string) => `${o.project}/${id}.jsonl`
      const moved = threadsSince(o.store.sessions(), id => { try { return statSync(file(id)).mtimeMs } catch { return undefined } }, since)
      o.store.save(THREADS, moved.map(t => t.key))
      const threads = moved.map(t => ({ place: o.placeOf(t.key), file: file(t.id), key: t.key }))
      const iso = new Date(since).toISOString()
      const mistakes = selfReview(o.ledgers.text('waiting', iso), lastDay(now), iso, o.placeOf)
      const c: Conversation = { connector: 'slack', chat: o.botDm, kind: 'dm', agentDm: true }
      const task = taskAsOwner({
        content: dreamTask(o.mem, threads, iso, { dir: `${o.code}/skills`, pr: await ownsRepo }, mistakes, o.hasSdk),
        meta: { channel: o.botDm, thread_ts: '', place: `DM with ${o.title} (dream)`, permalink: '' },
        origin: { channel: o.botDm, ts: '' },
        scheduled: true,
      })
      log('dream starts, memory saved to', snap)
      if (o.deliver(c, task, task.meta.place, 'side-dream') !== 'failed') writeFileSync(DREAMT, String(now), { mode: 0o600 })
    },
    lessons(lessons: DreamLesson[]) {
      const sessions = o.store.sessions()
      const keys = (o.store.load(THREADS) ?? []) as string[]
      const chats = Object.fromEntries(keys.flatMap(k => sessions[k] ? [[k, chatText(readFile(`${o.project}/${sessions[k]}.jsonl`).split('\n'))]] : []))
      const said = applyLessons({ dir: o.mem.own, chats, lessons, limits: o.limits(), now: Date.now() })
      log('dream lessons', said.replace(/\n/g, '; '))
      return said
    },
    kageletDreams(now: number) {
      if (!o.hasSdk || o.paused()) return
      const rows = kageletRows(readKagelets(o.kagelets), { runs: o.ledgers.text('runs'), costs: '', now })
      const last = new Map(Object.entries((o.store.load(KDREAMT) ?? {}) as Record<string, number>))
      for (const name of dreamsDue(rows, new Map(rows.flatMap(r => r.lastRun ? [[r.name, r.lastRun] as const] : [])), last, now, o.quiet(now))) {
        const lane = rows.find(r => r.name === name)!.key!
        const conv = o.store.conversation(lane)
        if (!conv) continue
        const since = new Date(Math.max(last.get(name) ?? 0, now - DAY)).toISOString()
        const input = dreamInput(name, since, lastDay(now), o.ledgers.text('reports'))
        const key = lane.replace('#side-kagelet-', '#side-kdream-')
        o.store.seen(key, conv.conversation, `${name} (dream)`, now)
        const { chat, thread } = conv.conversation
        const task = taskAsOther({ scheduled: true, content: kageletDreamTask(name, o.kmem.notes(name), input.events, input.reports, since),
          meta: { channel: chat, thread_ts: thread ?? '', place: `${name} (dream)`, permalink: '' }, origin: { channel: chat, ts: '' } })
        log(`kagelet ${name} dreams`)
        if (o.toSession(key, task) !== 'failed') o.store.save(KDREAMT, { ...Object.fromEntries(last), [name]: now })
        return
      }
    },
  }
}
