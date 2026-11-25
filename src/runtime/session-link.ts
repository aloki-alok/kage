import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import type { ProbeArg } from './probe-jobs.ts'
import { dirname, join } from 'node:path'
import type { LimitCounts } from '../core/board.ts'
import { PANEL_KEYS, type PanelAction } from '../core/kagelets/view.ts'
import type { Dispatcher } from '../core/sessions.ts'
import type { Reloaded } from '../core/settings.ts'
import { isJobLane } from '../core/conversations.ts'
import { log } from './log.ts'
import { linkToken, readToken, sameSecret } from './owner-key.ts'
import type { ChannelReply, FromSession, ToSession } from './protocol.ts'
import type { Updated } from './self-update.ts'
import { awayCommand, type AfkCommand } from '../core/afk.ts'
import type { scheduler } from './scheduler.ts'

const REPLY_PREFIX: Record<ChannelReply['type'], string> = { mail: 'mail:', wa: 'wa:', voice: 'voice:', sms: 'sms:', gh: 'gh:' }
type Replies = Record<ChannelReply['type'], (key: string, text: string) => void>
const isReplyType = (t: unknown): t is ChannelReply['type'] => typeof t === 'string' && Object.hasOwn(REPLY_PREFIX, t)

export function routeReply(key: string, m: ChannelReply, o: Replies) {
  if (key.startsWith(REPLY_PREFIX[m.type])) o[m.type](key, m.text)
}

const holdFile = (dir: string, key: string) => join(dir, 'held', encodeURIComponent(key))
const holderOf = (dir: string, key: string) => { try { return Number(readFileSync(holdFile(dir, key), 'utf8')) } catch { return 0 } }
const alive = (pid: number) => {
  if (!(pid > 0)) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}
const heldKeys = (dir: string) => { try { return readdirSync(join(dir, 'held')).map(decodeURIComponent) } catch { return [] } }

export function restoreHolds(dir: string, d: Dispatcher<ToSession>) {
  for (const key of heldKeys(dir)) {
    if (alive(holderOf(dir, key)) && 'id' in d.hold(key)) continue
    rmSync(holdFile(dir, key), { force: true })
  }
}

type Options = Replies & {
  ownerKey: string
  failed: (m: ToSession) => void
  schedules: Pick<ReturnType<typeof scheduler>, 'add' | 'remove'>
  callCode?: () => string
  tell?: (key: string, text: string) => { ok: true; held?: true } | { refused: string }
  say?: (text: string, at?: { channel: string; thread_ts: string }) => Promise<{ ok: true; channel: string; ts: string } | { refused: string }>
  relay?: (action: string, key?: string) => { ok: true; keys: string[] } | { refused: string }
  trust?: (action: string, id: string) => { ok: true; text: string } | { refused: string }
  reload?: () => Reloaded
  paused?: () => { until: number; held: number } | undefined
  limitCounts?: () => LimitCounts
  quiesce?: () => { key: string; why: string }[]
  health?: () => string[]
  healthRows?: () => object[]
  end?: (key: string, cut: boolean) => string
  kagelet?: (action: PanelAction, name: string) => Promise<string>
  away?: (c: AfkCommand) => Promise<string>
  update?: (stable: boolean) => Promise<Updated>
  jobs?: (m: unknown) => { text: string } | { refused: string }
}
type Link = { d: Dispatcher<ToSession>; o: Options; dir: string; owned: Set<string> }
type Conn = { sock: Socket; key: string; held: string; send: (m: ToSession) => void }
type Msg = Partial<FromSession> & { key?: unknown; id?: unknown; text?: unknown; pid?: unknown; name?: unknown; action?: unknown; ownerKey?: unknown; readToken?: unknown; linkToken?: unknown }

export function listenForSessions(path: string, d: Dispatcher<ToSession>, o: Options) {
  try { unlinkSync(path) } catch {}
  const l: Link = { d, o, dir: dirname(path), owned: new Set() }
  setInterval(() => {
    for (const key of heldKeys(l.dir)) if (!l.owned.has(key) && !alive(holderOf(l.dir, key))) free(l, key)
  }, 5000).unref()
  const server = createServer(sock => {
    const c: Conn = { sock, key: '', held: '', send: m => sock.write(JSON.stringify(m) + '\n') }
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: Msg
        try { m = JSON.parse(line) } catch { continue }
        if (!m || typeof m !== 'object') continue
        if (!c.key && !c.held && Object.hasOwn(COMMANDS, String(m.type))) command(l, c, m)
        else if (c.key) fromSession(l, c, m)
      }
    })
    sock.on('close', () => {
      if (c.key) d.disconnect(c.key, c.send)
      if (c.held) { l.owned.delete(c.held); free(l, c.held) }
    })
    sock.on('error', () => {})
  })
  server.listen(path, () => chmodSync(path, 0o600))
  return server
}

function free({ d, o, dir }: Link, key: string) {
  rmSync(holdFile(dir, key), { force: true })
  d.release(key, Date.now()).forEach(o.failed)
}

const answer = (c: Conn, type: string, r: object) => c.sock.write(JSON.stringify({ type, ...r }) + '\n')

type Command = { from: 'owner' | 'read' | 'update' | 'session'; run: (l: Link, c: Conn, m: Msg) => void }
const owner = (run: Command['run']): Command => ({ from: 'owner', run })
const read = (run: Command['run']): Command => ({ from: 'read', run })
const update = (run: Command['run']): Command => ({ from: 'update', run })
const session = (run: Command['run']): Command => ({ from: 'session', run })
const OWNER_ONLY = "this needs the owner key, which only the kage command in the owner's own terminal sends"
const OWNER_THREADS = "kage status works in the owner's threads and terminal"
const UPDATE_THREADS = "kage update works in the owner's threads and terminal"
const GATES: Record<Command['from'], { admits: (l: Link, m: Msg) => boolean; refuse: (c: Conn, type: string) => void }> = {
  owner: { admits: ({ o }, m) => sameSecret(m.ownerKey, o.ownerKey), refuse: (c, type) => answer(c, type, { refused: OWNER_ONLY }) },
  read: { admits: ({ o }, m) => sameSecret(m.ownerKey, o.ownerKey) || sameSecret(m.readToken, readToken(o.ownerKey)), refuse: (c, type) => answer(c, type, { refused: OWNER_THREADS }) },
  update: { admits: ({ o }, m) => sameSecret(m.ownerKey, o.ownerKey) || sameSecret(m.readToken, readToken(o.ownerKey)), refuse: (c, type) => answer(c, type, { refused: UPDATE_THREADS }) },
  session: { admits: ({ o }, m) => typeof m.key === 'string' && sameSecret(m.linkToken, linkToken(o.ownerKey, m.key)), refuse: c => c.sock.destroy() },
}

function command(l: Link, c: Conn, m: Msg) {
  const type = String(m.type), { from, run } = COMMANDS[type]!
  if (GATES[from].admits(l, m)) return run(l, c, m)
  log('socket refused', from, type)
  GATES[from].refuse(c, type)
}

const COMMANDS: Record<string, Command> = {
  hold: owner((l, c, m) => { if (typeof m.key === 'string') hold(l, c, m.key, typeof m.pid === 'number' ? m.pid : 0) }),
  board: read(({ d, o }, c) => {
    const paused = o.paused?.()
    const limitCounts = o.limitCounts?.()
    answer(c, 'board', { ...d.status(Date.now()), ...(paused && { paused }), ...(limitCounts && { limitCounts }) })
  }),
  health: read(({ o }, c) => answer(c, 'health', { lines: o.health?.() ?? [], rows: o.healthRows?.() ?? [] })),
  update: update(({ o }, c, m) => {
    if (!o.update) return answer(c, 'update', { refused: 'this hub cannot update itself' })
    void o.update((m as { stable?: unknown }).stable === true).then(r => answer(c, 'update', r), (e: Error) => answer(c, 'update', { refused: e.message }))
  }),
  end: owner(({ o }, c, m) => { if (o.end && typeof m.key === 'string') answer(c, 'end', { text: o.end(m.key, (m as { cut?: unknown }).cut === true) }) }),
  quiesce: owner(({ o }, c) => { if (o.quiesce) answer(c, 'quiesce', { waiting: o.quiesce() }) }),
  reload: owner(({ o }, c) => answer(c, 'reload', o.reload?.() ?? { refused: 'this hub cannot reload' })),
  callcode: owner(({ o }, c) => {
    const code = o.callCode?.()
    answer(c, 'callcode', code ? { code } : { refused: 'voice is off' })
  }),
  tell: owner(({ o }, c, m) => {
    if (typeof m.key !== 'string' || typeof m.text !== 'string') return
    answer(c, 'tell', !m.text.trim() ? { refused: 'empty message' } : o.tell?.(m.key, m.text.trim()) ?? { refused: 'this hub cannot take messages' })
  }),
  job: owner(({ o }, c, m) => answer(c, 'job', o.jobs ? o.jobs(m) : { refused: 'this hub cannot change jobs from the terminal' })),
  away: owner((l, c, m) => away(l, c, m as { back?: unknown; until?: unknown; minutes?: unknown; note?: unknown })),
  say: owner((l, c, m) => { if (typeof m.text === 'string') say(l, c, m.text, m as { channel?: unknown; thread_ts?: unknown }) }),
  relay: owner(({ o }, c, m) => answer(c, 'relay', typeof m.action === 'string' && ['allow', 'deny', 'list'].includes(m.action) ? o.relay?.(m.action, typeof m.key === 'string' ? m.key : undefined) ?? { refused: 'this hub has no relay' } : { refused: 'use allow, deny or list' })),
  trust: owner(({ o }, c, m) => answer(c, 'trust', typeof m.action === 'string' && typeof m.id === 'string' ? o.trust?.(m.action, m.id) ?? { refused: 'this hub has no trust record' } : { refused: 'use revoke with an id' })),
  kagelet: owner((l, c, m) => { if (typeof m.name === 'string') kagelet(l, c, m.name, m.action as PanelAction) }),
  stop: owner(({ d }, c, m) => { if (typeof m.key === 'string') answer(c, 'stop', d.stop(m.key, Date.now())) }),
  hello: session(({ d }, c, m) => {
    if (typeof m.key !== 'string') return
    if (d.connect(m.key, c.send)) c.key = m.key
    else c.sock.destroy()
  }),
}

function hold({ d, dir, owned }: Link, c: Conn, key: string, pid: number) {
  let r = d.hold(key)
  if ('refused' in r && r.refused === 'held' && !owned.has(key) && alive(pid) && holderOf(dir, key) === pid) r = { id: d.saved()[key]! }
  if ('id' in r) {
    c.held = key
    owned.add(key)
    mkdirSync(join(dir, 'held'), { recursive: true, mode: 0o700 })
    writeFileSync(holdFile(dir, key), String(pid), { mode: 0o600 })
  }
  answer(c, 'hold', r)
}

function say({ o }: Link, c: Conn, said: string, at: { channel?: unknown; thread_ts?: unknown }) {
  const reply = (r: object) => answer(c, 'say', r)
  const text = said.trim()
  if (!text) reply({ refused: 'empty message' })
  else if (typeof at.channel === 'string' !== (typeof at.thread_ts === 'string')) reply({ refused: 'a reply needs both channel and thread_ts' })
  else if (!o.say) reply({ refused: 'this hub cannot post' })
  else void o.say(text, typeof at.channel === 'string' ? { channel: at.channel, thread_ts: at.thread_ts as string } : undefined).then(reply)
}

function away({ o }: Link, c: Conn, m: { back?: unknown; until?: unknown; minutes?: unknown; note?: unknown }) {
  const reply = (r: { text: string } | { refused: string }) => answer(c, 'away', r)
  if (!o.away) return reply({ refused: 'AFK mode is off here (afk.on is false)' })
  if (m.back !== undefined && m.back !== true) return reply({ refused: 'back is true or left out' })
  const command = m.back === true ? { kind: 'back' as const } : awayCommand({
    ...typeof m.until === 'string' && { until: m.until }, ...typeof m.minutes === 'number' && { minutes: m.minutes }, ...typeof m.note === 'string' && { note: m.note },
  })
  if (typeof command === 'string') return reply({ refused: command })
  void o.away(command).then(text => reply({ text }), (e: Error) => reply({ refused: e.message }))
}

function kagelet({ o }: Link, c: Conn, name: string, action: PanelAction) {
  const reply = (r: { text: string } | { refused: string }) => answer(c, 'kagelet', r)
  if (!Object.values(PANEL_KEYS).includes(action)) reply({ refused: `kage top runs, pauses, resumes or removes a kagelet, revokes the standing approval, or lifts deny holds, not ${String(action)}` })
  else if (!o.kagelet) reply({ refused: 'this hub cannot act on kagelets' })
  else void o.kagelet(action, name).then(text => reply({ text }), (e: Error) => reply({ refused: e.message }))
}

function fromSession({ d, o }: Link, { key }: Conn, m: Msg) {
  if (m.type === 'permission' && typeof m.id === 'string') {
    d.permission(key, m.id)
  } else if (isReplyType(m.type) && typeof m.text === 'string') {
    routeReply(key, { type: m.type, text: m.text }, o)
  } else if (m.type === 'schedule') {
    const j = m as Partial<{ id: string; cron: string; prompt: string; recurring: boolean; lane: boolean; model: string; probe: ProbeArg; shadow: { of: string; live: string } }>
    if (typeof j.id === 'string' && typeof j.cron === 'string' && typeof j.prompt === 'string') {
      const no = o.schedules.add(key, { id: j.id, cron: j.cron, prompt: j.prompt, recurring: j.recurring !== false, ...(typeof j.lane === 'boolean' && { lane: j.lane }), ...(typeof j.model === 'string' && { model: j.model }), ...(j.probe && { probe: j.probe }), ...(typeof j.shadow?.of === 'string' && typeof j.shadow.live === 'string' && { shadow: { of: j.shadow.of, live: j.shadow.live } }) }, Date.now())
      if (no) log('schedule refused', key, no)
    }
  } else if (m.type === 'unschedule' && typeof m.id === 'string') {
    if (isJobLane(key)) log('unschedule refused in a job lane', key); else o.schedules.remove(key, m.id)
  }
}
