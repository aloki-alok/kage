// The nightly dreams. Kage's own: in the small hours, while every session is quiet, it learns from the day's threads and
// tidies its memory (core/dream.ts), in a side lane of the bot DM so the DM's own conversation is untouched; the memory is
// snapshotted first, so `kage dream undo` restores it. Each kagelet that ran gets one too (#98): a lane with no tool but
// propose_memory, and nothing applies until Kage reviews it (review_kagelet_memory).
import { execFile } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { log } from '../runtime/log.ts'
import { selfReview } from '../core/ledgers.ts'
import { dreamDue, dreamTask, threadsSince } from '../core/dream.ts'
import { dreamInput, dreamsDue, kageletDreamTask } from '../core/kagelet-memory.ts'
import { kageletRows } from '../core/kagelets.ts'
import type { Conversation, Lane } from '../core/conversations.ts'
import type { Task } from '../core/task.ts'
import { readKagelets } from '../runtime/kagelet-files.ts'
import type { kageletMemory } from '../runtime/kagelet-memory.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import { snapshotMemory } from '../runtime/memory-snapshot.ts'
import { canPushToKage } from '../runtime/repo-access.ts'
import type { Store } from '../runtime/store.ts'
import { otherTask, ownerTask } from '../core/gate.ts'

const readFile = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const DAY = 24 * 3600_000

export function dreams(o: {
  dir: string; code: string; title: string; botDm: string
  mem: { own: string; owner: string }; project: string   // the Claude Code project folder that holds the transcripts
  kagelets: string; kmem: ReturnType<typeof kageletMemory>; hasSdk: boolean
  store: Store; ledgers: Ledgers; placeOf: (key: string) => string
  paused: () => boolean; quiet: (now: number) => boolean
  deliver: (c: Conversation, task: Task, place: string, lane: Lane) => string | undefined
  toSession: (key: string, task: Task) => string | undefined
}) {
  // UTC days: today's and yesterday's rows cover at most the 24 hours back.
  const lastDay = (now: number) => [new Date(now - DAY), new Date(now)].flatMap(t => o.ledgers.events(t.toISOString().slice(0, 10)))
  const DREAMT = `${o.dir}/dream-sent`, KDREAMT = 'kagelet-dream-last'
  // Asked once: push access to the Kage repo is what makes this the repo owner's hub (runtime/repo-access.ts).
  const ownsRepo = canPushToKage(args => new Promise((ok, no) => execFile('gh', args, { timeout: 15_000 }, (e, out) => e ? no(e) : ok(out))))
  return {
    async dream(now: number) {
      const last = Number(readFile(DREAMT).trim()) || undefined
      if (o.paused() || !dreamDue(now, last, o.quiet(now))) return   // a dream in the pause would only hit the limit
      const snap = snapshotMemory(o.mem.own, now)
      // At most a day back, so a Mac that slept through a few nights is not handed a week of threads.
      const since = Math.max(last ?? 0, now - DAY)
      const file = (id: string) => `${o.project}/${id}.jsonl`
      const threads = threadsSince(o.store.sessions(), id => { try { return statSync(file(id)).mtimeMs } catch { return undefined } }, since)
        .map(t => ({ place: o.placeOf(t.key), file: file(t.id) }))
      const iso = new Date(since).toISOString()
      const mistakes = selfReview(o.ledgers.text('waiting', iso), lastDay(now), iso, o.placeOf)
      const c: Conversation = { connector: 'slack', chat: o.botDm, kind: 'dm', agentDm: true }
      // Kage's own nightly job over the owner's threads, started by the hub, so it runs at the owner's trust.
      const task = ownerTask({
        content: dreamTask(o.mem, threads, iso, { dir: `${o.code}/skills`, pr: await ownsRepo }, mistakes),
        meta: { channel: o.botDm, thread_ts: '', place: `DM with ${o.title} (dream)`, permalink: '' },
        origin: { channel: o.botDm, ts: '' },
        scheduled: true,
      })
      log('dream starts, memory saved to', snap)
      if (o.deliver(c, task, task.meta.place, 'side-dream') !== 'failed') writeFileSync(DREAMT, String(now), { mode: 0o600 })
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
        const task = otherTask({ scheduled: true, content: kageletDreamTask(name, o.kmem.notes(name), input.events, input.reports, since),
          meta: { channel: chat, thread_ts: thread ?? '', place: `${name} (dream)`, permalink: '' }, origin: { channel: chat, ts: '' } })
        log(`kagelet ${name} dreams`)
        if (o.toSession(key, task) !== 'failed') o.store.save(KDREAMT, { ...Object.fromEntries(last), [name]: now })
        return   // one a tick: its session is not quiet now, and the next tick picks the next kagelet
      }
    },
  }
}
