// One Claude session per conversation: the dispatcher and its runner interface. Keys come from core/conversations.ts.

// What happened to a task: handed over, its session starting, waiting for a slot, waiting while the
// owner has the thread in a terminal, or lost (the session could not start).
export type Delivery = 'sent' | 'starting' | 'queued' | 'held' | 'failed'

// start/stop run a session (start throws if it can't). lastActivity: when it last wrote
// its transcript (ms). busy: Claude is mid-turn, which a long tool call can be with no writes; 'watching': idle, kept
// only because a timed check (cron job) of its own is alive. outlivesHub: the session keeps running when the hub
// restarts (a tmux pane); a session inside the hub dies with it.
export type Runner = { start(key: string, id: string): void; stop(key: string): void; lastActivity(key: string): number; busy(key: string): boolean | 'watching'; outlivesHub?(key: string): boolean }

// A runtime switch without closing anything: threads whose pane ran when the hub started keep it,
// and every session started from now on runs on `next`. A closed pane's thread resumes on `next`.
export function mixRunners(panes: Runner, next: Runner, onPane: Set<string>): Runner {
  const of = (k: string) => (onPane.has(k) ? panes : next)
  return {
    start: (k, id) => { onPane.delete(k); next.start(k, id) },
    stop: k => { const w = of(k); onPane.delete(k); w.stop(k) },
    lastActivity: k => of(k).lastActivity(k),
    busy: k => of(k).busy(k),
    outlivesHub: k => of(k).outlivesHub?.(k) ?? false,
  }
}

// Routes tasks to one session per thread. Each thread keeps its session id for good, so a
// session that closed or restarted resumes the same conversation. At most `max` sessions run.
export class Dispatcher<M> {
  #runner: Runner
  #opts: { max: number; idleMs: number; connectMs: number; evictMs: number; newId: () => string }
  #ids: Map<string, string>
  #live = new Set<string>()
  #conns = new Map<string, (m: M) => void>()
  #pending = new Map<string, M[]>()
  #touched = new Map<string, number>()
  #waiting: string[] = []
  #held = new Set<string>()          // threads the owner took into a terminal: their tasks wait
  #midTurn = new Map<string, M[]>()  // tasks sent while the session was busy: queued, maybe never read
  #perms = new Map<string, string>()
  #startedAt = new Map<string, number>()

  // evictMs: how long a session must sit quiet before a new thread may take its slot.
  constructor(w: Runner, o: { max: number; idleMs: number; connectMs: number; evictMs: number; newId: () => string; saved?: Record<string, string> }) {
    this.#runner = w
    this.#opts = o
    this.#ids = new Map(Object.entries(o.saved ?? {}))
  }

  saved = () => Object.fromEntries(this.#ids)
  connection = (key: string) => this.#conns.get(key)

  // Sessions already running when the router starts (it restarted, they did not).
  adopt(keys: string[], now: number) {
    for (const k of keys) if (this.#ids.has(k)) { this.#live.add(k); this.#startedAt.set(k, now) }
  }

  // 'failed': the session could not start; the task was not kept.
  task(key: string, msg: M, now: number): Delivery {
    this.#touched.set(key, now)
    const send = this.#conns.get(key)
    if (send) {
      // A task to a quiet session starts a turn, so it reaches the transcript; one sent mid-turn waits in a queue.
      this.#midTurn.set(key, this.#busy(key) ? [...(this.#midTurn.get(key) ?? []), msg] : [])
      send(msg)
      return 'sent'
    }
    // The connect clock runs from the first task left waiting, so a session that is only
    // restarting gets the full connectMs again.
    if (!this.#pending.has(key)) this.#startedAt.set(key, now)
    this.#pending.set(key, [...(this.#pending.get(key) ?? []), msg])
    if (this.#held.has(key)) return 'held'
    if (this.#live.has(key)) return 'starting'
    return this.#admit(key, now)
  }

  // Whether the hub can restart itself without cutting anything off: every session connected, not
  // mid-turn, not asking, and quiet for evictMs; no task waiting for a slot; no thread held by a
  // terminal. An SDK session dies with the hub, so this must be true for it too.
  quietEverywhere(now: number): boolean {
    const s = this.status(now)
    // A pane kept only by its timed check outlives the restart, check and all, so it does not block one.
    return !s.waiting.length && !s.held.length
      && s.live.every(l => (l.state === 'quiet' || (l.state === 'watching' && this.#runner.outlivesHub?.(l.key))) && l.quietMs >= this.#opts.evictMs)
  }

  // Whether a task for this thread would start without evicting another session or jumping the
  // queue. A connector that must never push the owner's threads out asks first (voice does).
  hasFreeSlot = (key: string) => this.#live.has(key) || (this.#live.size < this.#opts.max && !this.#waiting.length)

  // A connector ends a conversation of its own (a voice call hung up): close its session now so the
  // slot is free at once, and forget a task waiting for one. Its id stays, so it could resume.
  // Returns the tasks it forgot, which no session read, for a caller that keeps them (runtime/limit-pause.ts).
  end(key: string): M[] {
    if (this.#live.has(key)) this.#close(key)
    const unread = this.#pending.get(key) ?? []
    this.#pending.delete(key)
    this.#waiting = this.#waiting.filter(k => k !== key)
    return unread
  }

  // end, and the next task starts a new conversation: the old one can't be resumed (the safety check flagged it).
  reset(key: string) {
    this.end(key)
    this.#ids.delete(key)
  }

  // Start the thread's session if there is a slot (a full house frees its quietest), else queue it.
  #admit(key: string, now: number): 'starting' | 'queued' | 'failed' {
    // Full: the quietest session gives up its slot. It loses nothing, its next task resumes it.
    const quiet = this.#live.size < this.#opts.max ? undefined : this.#quietest(now)
    if (quiet) this.#close(quiet)
    if (this.#live.size < this.#opts.max) {
      if (this.#start(key, now)) return 'starting'
      this.#pending.delete(key)
      return 'failed'
    }
    if (!this.#waiting.includes(key)) this.#waiting.push(key)
    return 'queued'
  }

  // The owner takes the thread's session into a terminal now, like Esc in Claude Code: a turn in
  // progress stops, an open approval is denied, a timed check in it ends. `cut` says which, so attach
  // can tell them. Tasks that come while it is held wait for the terminal to give it back.
  hold(key: string): { id: string; cut?: 'busy' | 'asking' | 'watching' } | { refused: 'unknown' | 'held' } {
    const id = this.#ids.get(key)
    if (!id) return { refused: 'unknown' }
    if (this.#held.has(key)) return { refused: 'held' }
    let cut: 'busy' | 'asking' | 'watching' | undefined
    if (this.#live.has(key)) {
      const kind = this.#busyKind(key)
      cut = [...this.#perms.values()].includes(key) ? 'asking' : kind === true ? 'busy' : kind || undefined
      // Cutting the turn may drop what was queued behind it: those tasks wait for the terminal like new ones.
      const queued = cut ? this.#midTurn.get(key) ?? [] : []
      if (queued.length) this.#pending.set(key, [...queued, ...this.#pending.get(key) ?? []])
      this.#close(key)
    }
    this.#waiting = this.#waiting.filter(k => k !== key)
    this.#held.add(key)
    return cut ? { id, cut } : { id }
  }

  // The console closes one session. Its next task resumes it, so only work in progress is at risk:
  // refused while it starts, asks or works.
  stop(key: string, now: number): { ok: true } | { refused: 'closed' | 'starting' | 'busy' | 'asking' } {
    if (!this.#live.has(key)) return { refused: 'closed' }
    if (!this.#conns.has(key)) return { refused: 'starting' }
    if ([...this.#perms.values()].includes(key)) return { refused: 'asking' }
    if (now - this.#last(key) < this.#opts.evictMs || this.#busy(key)) return { refused: 'busy' }
    this.#close(key)
    return { ok: true }
  }

  // The terminal gave the thread back. Tasks that came meanwhile start its session again; the ones
  // that cannot (the session could not start) are returned, so the router can say so.
  release(key: string, now: number): M[] {
    const waiting = this.#pending.get(key)
    if (!this.#held.delete(key) || !waiting) return []
    return this.#admit(key, now) === 'failed' ? waiting : []
  }

  // What runs now, for "@kage status".
  status(now: number) {
    const asking = new Set(this.#perms.values())
    // Work shows first, then a question for you, then a watch: a watching session that asks must say so.
    const state = (k: string) => {
      if (!this.#conns.has(k)) return 'starting'
      const b = this.#busyKind(k)
      return b === true ? 'busy' : asking.has(k) ? 'asking' : b === 'watching' ? 'watching' : 'quiet'
    }
    return {
      live: [...this.#live].map(key => ({ key, state: state(key), quietMs: now - this.#last(key) })),
      waiting: [...this.#waiting],
      held: [...this.#held],
      max: this.#opts.max,
    }
  }

  // Last activity: a task handed to it, or a write to its transcript.
  #last = (k: string) => Math.max(this.#touched.get(k) ?? 0, this.#runner.lastActivity(k))

  // A busy check that fails (tmux gone, a capture error) counts as busy: never close on a guess.
  // 'watching' is truthy, so a session kept by its timed check counts as busy for eviction; hold() asks for it by name.
  #busy(k: string): boolean { return !!this.#busyKind(k) }
  #busyKind(k: string): boolean | 'watching' {
    try { return this.#runner.busy(k) } catch { return true }
  }

  // A connected session with nothing pending, no open approval, not mid-turn, quiet for evictMs.
  #quietest(now: number): string | undefined {
    const asking = new Set(this.#perms.values())
    let best: string | undefined
    for (const k of this.#live) {
      if (!this.#conns.has(k) || this.#pending.has(k) || asking.has(k)) continue
      if (now - this.#last(k) < this.#opts.evictMs || this.#busy(k)) continue
      if (!best || this.#last(k) < this.#last(best)) best = k
    }
    return best
  }

  #close(k: string) {
    this.#midTurn.delete(k)
    this.#runner.stop(k)
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

  // Closes sessions idle for idleMs and sessions that never connected within connectMs, then starts
  // waiting threads. Returns the tasks it could not deliver, so the router can say so in Slack.
  sweep(now: number): M[] {
    const dropped: M[] = []
    const asking = new Set(this.#perms.values())
    for (const k of this.#live) {
      const pending = this.#pending.get(k)
      if (pending && !this.#conns.has(k)) {
        if (now - (this.#startedAt.get(k) ?? now) < this.#opts.connectMs) continue
        dropped.push(...pending)
        this.#pending.delete(k)
      } else if (pending || now - this.#last(k) < this.#opts.idleMs || asking.has(k) || this.#busy(k)) continue
      this.#close(k)
    }
    // Threads waiting for a slot also take the slot of a session that has since gone quiet.
    while (this.#waiting.length) {
      if (this.#live.size >= this.#opts.max) {
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

  // Whether a scheduled run may go to this thread now. blocked: held by a terminal, a task pending
  // or queued for a slot, or its session not connected yet. busy: connected and mid-turn. A closed
  // thread is ready: the run starts it.
  ready(key: string): 'ready' | 'busy' | 'blocked' {
    if (this.#held.has(key) || this.#pending.has(key) || this.#waiting.includes(key)) return 'blocked'
    if (!this.#live.has(key)) return 'ready'
    if (!this.#conns.has(key)) return 'blocked'
    return this.#busy(key) ? 'busy' : 'ready'
  }

  #start(key: string, now: number): boolean {
    if (!this.#ids.has(key)) this.#ids.set(key, this.#opts.newId())
    try {
      this.#runner.start(key, this.#ids.get(key)!)
    } catch {
      return false
    }
    this.#live.add(key)
    this.#startedAt.set(key, now)
    return true
  }
}
