// One Claude session per thread: the session key, the dispatcher and its window interface.

// One Claude session per conversation: a thread, or the top-level DM with the bot.
export const threadKey = (m: { channel: string; ts: string; thread_ts?: string }, botDm: string) =>
  m.channel === botDm && !m.thread_ts ? 'dm' : `${m.channel}:${m.thread_ts ?? m.ts}`

// start/stop run a session's window (start throws if it can't). lastActivity: when it last wrote
// its transcript (ms). busy: Claude is mid-turn, which a long tool call can be with no writes.
export type Windows = { start(key: string, id: string): void; stop(key: string): void; lastActivity(key: string): number; busy(key: string): boolean }

// Routes tasks to one session per thread. Each thread keeps its session id for good, so a
// window that closed or restarted resumes the same conversation. At most `max` windows run.
export class Dispatcher<M> {
  #w: Windows
  #o: { max: number; idleMs: number; connectMs: number; evictMs: number; newId: () => string }
  #ids: Map<string, string>
  #live = new Set<string>()
  #conns = new Map<string, (m: M) => void>()
  #pending = new Map<string, M[]>()
  #touched = new Map<string, number>()
  #waiting: string[] = []
  #perms = new Map<string, string>()
  #startedAt = new Map<string, number>()

  // evictMs: how long a session must sit quiet before a new thread may take its slot.
  constructor(w: Windows, o: { max: number; idleMs: number; connectMs: number; evictMs: number; newId: () => string; saved?: Record<string, string> }) {
    this.#w = w
    this.#o = o
    this.#ids = new Map(Object.entries(o.saved ?? {}))
  }

  saved = () => Object.fromEntries(this.#ids)
  connection = (key: string) => this.#conns.get(key)

  // Windows already running when the router starts (it restarted, they did not).
  adopt(keys: string[], now: number) {
    for (const k of keys) if (this.#ids.has(k)) { this.#live.add(k); this.#startedAt.set(k, now) }
  }

  // 'failed': the window could not open; the task was not kept.
  task(key: string, msg: M, now: number): 'sent' | 'starting' | 'queued' | 'failed' {
    this.#touched.set(key, now)
    const send = this.#conns.get(key)
    if (send) { send(msg); return 'sent' }
    // The connect clock runs from the first task left waiting, so a window that is only
    // restarting gets the full connectMs again.
    if (!this.#pending.has(key)) this.#startedAt.set(key, now)
    this.#pending.set(key, [...(this.#pending.get(key) ?? []), msg])
    if (this.#live.has(key)) return 'starting'
    // Full: the quietest session gives up its slot. It loses nothing, its next task resumes it.
    const quiet = this.#live.size < this.#o.max ? undefined : this.#quietest(now)
    if (quiet) this.#close(quiet)
    if (this.#live.size < this.#o.max) {
      if (this.#start(key, now)) return 'starting'
      this.#pending.delete(key)
      return 'failed'
    }
    if (!this.#waiting.includes(key)) this.#waiting.push(key)
    return 'queued'
  }

  // What runs now, for "@kage status".
  status(now: number) {
    const asking = new Set(this.#perms.values())
    const state = (k: string) => !this.#conns.has(k) ? 'starting' : this.#busy(k) ? 'busy' : asking.has(k) ? 'asking' : 'quiet'
    return {
      live: [...this.#live].map(key => ({ key, state: state(key), quietMs: now - this.#last(key) })),
      waiting: [...this.#waiting],
    }
  }

  // Last activity: a task handed to it, or a write to its transcript.
  #last = (k: string) => Math.max(this.#touched.get(k) ?? 0, this.#w.lastActivity(k))

  // A connected session with nothing pending, no open approval, not mid-turn, quiet for evictMs.
  // A busy check that fails (tmux gone, a capture error) counts as busy: never close on a guess.
  #busy(k: string): boolean {
    try { return this.#w.busy(k) } catch { return true }
  }

  #quietest(now: number): string | undefined {
    const asking = new Set(this.#perms.values())
    let best: string | undefined
    for (const k of this.#live) {
      if (!this.#conns.has(k) || this.#pending.has(k) || asking.has(k)) continue
      if (now - this.#last(k) < this.#o.evictMs || this.#busy(k)) continue
      if (!best || this.#last(k) < this.#last(best)) best = k
    }
    return best
  }

  #close(k: string) {
    this.#w.stop(k)
    this.#live.delete(k)
    this.#conns.delete(k)
    for (const [id, key] of this.#perms) if (key === k) this.#perms.delete(id)
  }

  connect(key: string, send: (m: M) => void): boolean {
    if (!this.#live.has(key)) return false
    this.#conns.set(key, send)
    for (const m of this.#pending.get(key) ?? []) send(m)
    this.#pending.delete(key)
    return true
  }

  // Only the current connection's close counts; a stale one closing late changes nothing.
  // Its open approvals go with it: the Claude Code process that asked is gone.
  disconnect(key: string, send: (m: M) => void) {
    if (this.#conns.get(key) !== send) return
    this.#conns.delete(key)
    for (const [id, k] of this.#perms) if (k === key) this.#perms.delete(id)
  }

  permission(key: string, requestId: string) { this.#perms.set(requestId, key) }

  verdict(requestId: string, msg: M): boolean {
    const send = this.#conns.get(this.#perms.get(requestId) ?? '')
    if (!send) return false
    this.#perms.delete(requestId)
    send(msg)
    return true
  }

  // Closes windows idle for idleMs and windows that never connected within connectMs, then starts
  // waiting threads. Returns the tasks it could not deliver, so the router can say so in Slack.
  sweep(now: number): M[] {
    const dropped: M[] = []
    const asking = new Set(this.#perms.values())
    for (const k of this.#live) {
      const pending = this.#pending.get(k)
      if (pending && !this.#conns.has(k)) {
        if (now - (this.#startedAt.get(k) ?? now) < this.#o.connectMs) continue
        dropped.push(...pending)
        this.#pending.delete(k)
      } else if (pending || now - this.#last(k) < this.#o.idleMs || asking.has(k) || this.#busy(k)) continue
      this.#close(k)
    }
    // Threads waiting for a slot also take the slot of a session that has since gone quiet.
    while (this.#waiting.length) {
      if (this.#live.size >= this.#o.max) {
        const quiet = this.#quietest(now)
        if (!quiet) break
        this.#close(quiet)
      }
      const k = this.#waiting.shift()!
      if (!this.#start(k, now)) {
        dropped.push(...this.#pending.get(k) ?? [])
        this.#pending.delete(k)
      }
    }
    return dropped
  }

  #start(key: string, now: number): boolean {
    if (!this.#ids.has(key)) this.#ids.set(key, this.#o.newId())
    try {
      this.#w.start(key, this.#ids.get(key)!)
    } catch {
      return false
    }
    this.#live.add(key)
    this.#startedAt.set(key, now)
    return true
  }
}

// Repeating checks a session made with CronCreate live only in its Claude Code process, so
// closing the pane ends them. These are the jobs still alive: made since `since` (when the
// running process started), not cancelled, and not expired (recurring after 7 days, as Claude
// Code does; ponytail: a one-shot after a day, since its fire time isn't parsed).
export function liveCronJobs(results: { timestamp: string; text: string }[], since: number, now: number): string[] {
  const jobs = new Map<string, number>()
  for (const r of results) {
    const t = Date.parse(r.timestamp)
    const made = /Scheduled (\S+) job ([0-9a-f]+)/.exec(r.text)
    if (made && t >= since) jobs.set(made[2]!, t + (made[1] === 'recurring' ? 7 : 1) * 24 * 3600_000)
    const gone = /Cancelled job ([0-9a-f]+)/.exec(r.text)
    if (gone) jobs.delete(gone[1]!)
  }
  return [...jobs].filter(([, until]) => now < until).map(([id]) => id)
}
