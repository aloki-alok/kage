// The hub's scheduler: runs each thread's schedules (core/cron.ts) as tasks in that thread. They
// live in the store, so a hub restart, a closed session or a runtime switch loses none of them;
// only unschedule ends one.
import { log } from '../config.ts'
import { dueSchedules, nextRun, parseCron, type Schedule } from '../core/cron.ts'
import type { Delivery } from '../core/sessions.ts'
import type { Task } from './protocol.ts'
import type { Store } from './store.ts'

const PER_THREAD = 50
const DAY = 24 * 3600_000
// Four years, so a leap-day cron (29 Feb) counts as one that runs.
const RUNS_WITHIN = 4 * 366 * DAY
// A run that finds its thread mid-turn this long goes in anyway, and runs right after that turn: a
// thread that never looks idle (a background shell) must not starve its schedules.
const BUSY_WAIT = 5 * 60_000

export function scheduler(o: {
  store: Store
  deliver: (key: string, task: Task) => Delivery
  failed: (task: Task) => void
  // ready: nothing in flight. busy: mid-turn, so the run waits (at most BUSY_WAIT) instead of piling
  // up. blocked: held by a terminal, starting or queued for a slot, so the run waits.
  ready: (key: string) => 'ready' | 'busy' | 'blocked'
  // Owner trust only when every task this thread got came from the owner. The hub decides it, never
  // the session, so a teammate's turn can't set up a schedule that runs as the owner.
  trusted: (key: string) => boolean
}) {
  const { store } = o
  const dueSince = new Map<string, number>()   // job id -> when a run first found its thread busy
  return {
    // Returns why it was refused, or undefined when added.
    add(key: string, j: Pick<Schedule, 'id' | 'cron' | 'prompt' | 'recurring'>, now: number): string | undefined {
      try { parseCron(j.cron) } catch (e) { return (e as Error).message }
      if (!nextRun(j.cron, new Date(now), RUNS_WITHIN)) return `${j.cron} never runs`
      // ponytail: Slack threads only; email and WhatsApp need their own reply path for a run with no message.
      if (store.conversation(key)?.conversation.connector !== 'slack') return 'schedules work in Slack threads only'
      if (this.list(key).length >= PER_THREAD) return `this thread already has ${PER_THREAD} schedules`
      store.addSchedule({ ...j, key, fromOwner: o.trusted(key), created: now, lastFired: 0 })
      log('scheduled', j.id, j.cron, 'for', key)
    },
    // Jobs moved out of tmux panes (cli/export-crons.ts) when they stopped. `ranUntil` is when the export
    // read them: every run before it already happened in the pane, every run after it is the hub's.
    adopt(jobs: (Pick<Schedule, 'id' | 'key' | 'cron' | 'prompt' | 'recurring' | 'fromOwner' | 'created'>)[], ranUntil: number) {
      const adopted: string[] = [], skipped: string[] = []
      for (const j of jobs) {
        let ok = store.conversation(j.key)?.conversation.connector === 'slack'
        try { parseCron(j.cron) } catch { ok = false }
        if (!ok) { skipped.push(j.id); continue }
        // A recurring job resumes after ranUntil. A one-time job has not run (the pane would have
        // dropped it), so it looks for its time from ranUntil on. A job pinned to a date keeps
        // CronCreate's 7-day end, so it does not wake up again next year.
        const [, , dom, month] = j.cron.trim().split(/\s+/)
        const ends = dom !== '*' && month !== '*' ? { ends: j.created + 7 * DAY } : {}
        store.addSchedule(j.recurring ? { ...j, ...ends, lastFired: ranUntil } : { ...j, created: Math.max(j.created, ranUntil), lastFired: 0 })
        adopted.push(j.id)
      }
      return { adopted, skipped }
    },
    remove(key: string, id: string) { if (store.removeSchedule(id, key)) log('unscheduled', id, 'for', key) },
    list: (key: string) => store.schedules().filter(s => s.key === key),
    tick(now: number) {
      const { fire, drop } = dueSchedules(store.schedules(), now)
      const firing = new Set(fire.map(s => s.id))
      for (const id of dueSince.keys()) if (!firing.has(id)) dueSince.delete(id)
      for (const id of drop) if (!firing.has(id)) store.removeSchedule(id)
      // One at a time, each on its own: a failure in one run never costs another.
      for (const s of fire) {
        try {
          const r = o.ready(s.key)
          if (r === 'blocked') { dueSince.delete(s.id); continue }   // the 5 minutes count busy time only
          if (r === 'busy' && now - (dueSince.get(s.id) ?? dueSince.set(s.id, now).get(s.id)!) < BUSY_WAIT) continue
          dueSince.delete(s.id)
          // Marked before it is handed over: a crash right after costs one run, never runs it twice.
          store.fired(s.id, now)
          if (!s.recurring) store.removeSchedule(s.id)
          const c = store.conversation(s.key)
          if (!c) { log('schedule for an unknown thread', s.id, s.key); continue }
          const task: Task = {
            type: 'task', fromOwner: s.fromOwner,
            content: `Scheduled run of job ${s.id} (${s.cron}${s.recurring ? '' : ', once'}), set up earlier in this thread. Nobody wrote a new message.\n${s.prompt}`,
            meta: { channel: c.conversation.chat, thread_ts: c.conversation.thread ?? '', place: c.place, permalink: '' },
            origin: { channel: c.conversation.chat, ts: '' },
          }
          if (o.deliver(s.key, task) === 'failed') o.failed(task)
        } catch (e) { log('schedule run failed', s.id, e) }
      }
    },
  }
}

