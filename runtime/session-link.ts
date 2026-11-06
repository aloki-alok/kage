// The local socket the thread sessions connect to. Newline-delimited JSON; the socket file is
// private to this user.
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { Dispatcher } from '../core/sessions.ts'
import { log } from '../config.ts'
import type { FromSession, ToSession } from './protocol.ts'
import type { scheduler } from './scheduler.ts'

type Replies = { mail: (key: string, text: string) => void; wa: (key: string, text: string) => void; voice: (key: string, text: string) => void }

// An email, WhatsApp or voice reply from a session goes only to that session's own thread or chat.
// WhatsApp sends also pass the guard downstream.
export function routeReply(key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }, o: Replies) {
  if (m.type === 'mail' && key.startsWith('mail:')) o.mail(key, m.text)
  else if (m.type === 'wa' && key.startsWith('wa:')) o.wa(key, m.text)
  else if (m.type === 'voice' && key.startsWith('voice:')) o.voice(key, m.text)
}

// A thread a terminal holds (kage attach) is a file in held/ naming the attach process, so a hold
// outlives a hub restart: the new hub holds the thread again before any task can start it.
const holdFile = (dir: string, key: string) => join(dir, 'held', encodeURIComponent(key))
const holderOf = (dir: string, key: string) => { try { return Number(readFileSync(holdFile(dir, key), 'utf8')) } catch { return 0 } }
const alive = (pid: number) => {
  if (!(pid > 0)) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}
const heldKeys = (dir: string) => { try { return readdirSync(join(dir, 'held')).map(decodeURIComponent) } catch { return [] } }

// At hub start, before any connector runs: hold again every thread whose terminal still runs.
export function restoreHolds(dir: string, d: Dispatcher<ToSession>, now: number) {
  for (const key of heldKeys(dir)) {
    if (alive(holderOf(dir, key)) && 'id' in d.hold(key)) continue
    rmSync(holdFile(dir, key), { force: true })
  }
}

// failed: tasks that waited on a held thread and could not start when it came back.
export function listenForSessions(path: string, d: Dispatcher<ToSession>, o: Replies & {
  failed: (m: ToSession) => void
  schedules: Pick<ReturnType<typeof scheduler>, 'add' | 'remove'>
  callCode?: () => string
  // kage tell: the owner's words into one thread, as a task (router.ts decides how).
  tell?: (key: string, text: string) => { ok: true } | { refused: string }
}) {
  try { unlinkSync(path) } catch {}
  const dir = dirname(path)
  const owned = new Set<string>()   // holds with a terminal connected right now
  const free = (key: string) => {
    rmSync(holdFile(dir, key), { force: true })
    d.release(key, Date.now()).forEach(o.failed)
  }
  // A hold restored at start whose terminal never came back ends when that process is gone.
  setInterval(() => {
    for (const key of heldKeys(dir)) if (!owned.has(key) && !alive(holderOf(dir, key))) free(key)
  }, 5000).unref()
  const server = createServer(sock => {
    let key = ''
    let held = ''   // a terminal (kage attach) holding this thread; the hold ends when it disconnects
    let buf = ''
    const send = (m: ToSession) => sock.write(JSON.stringify(m) + '\n')
    sock.on('data', chunk => {
      buf += chunk
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: Partial<FromSession> & { key?: unknown; id?: unknown; text?: unknown; pid?: unknown }
        try { m = JSON.parse(line) } catch { continue }
        if (!m || typeof m !== 'object') continue   // a bare null or number must not take the hub down
        if (m.type === 'hold' && !key && !held && typeof m.key === 'string') {
          const pid = typeof m.pid === 'number' ? m.pid : 0
          let r = d.hold(m.key)
          // The terminal that held it before a hub restart takes its hold back.
          if ('refused' in r && r.refused === 'held' && !owned.has(m.key) && alive(pid) && holderOf(dir, m.key) === pid) r = { id: d.saved()[m.key]! }
          if ('id' in r) {
            held = m.key
            owned.add(held)
            mkdirSync(join(dir, 'held'), { recursive: true, mode: 0o700 })
            writeFileSync(holdFile(dir, held), String(pid), { mode: 0o600 })
          }
          sock.write(JSON.stringify({ type: 'hold', ...r }) + '\n')
        } else if (m.type === 'board' && !key && !held) {
          // The console's view of live state, which exists only in this process.
          sock.write(JSON.stringify({ type: 'board', ...d.status(Date.now()) }) + '\n')
        } else if (m.type === 'callcode' && !key && !held) {
          // A one-time code for a call Kage places to the owner (kage call); only someone on this machine reaches the socket.
          const code = o.callCode?.()
          sock.write(JSON.stringify({ type: 'callcode', ...(code ? { code } : { refused: 'voice is off' }) }) + '\n')
        } else if (m.type === 'tell' && !key && !held && typeof m.key === 'string' && typeof m.text === 'string') {
          // Only a console on this machine reaches here: a session's own socket (hello) never speaks as the owner.
          const r = !m.text.trim() ? { refused: 'empty message' } : o.tell?.(m.key, m.text.trim()) ?? { refused: 'this hub cannot take messages' }
          sock.write(JSON.stringify({ type: 'tell', ...r }) + '\n')
        } else if (m.type === 'stop' && !key && !held && typeof m.key === 'string') {
          sock.write(JSON.stringify({ type: 'stop', ...d.stop(m.key, Date.now()) }) + '\n')
        } else if (m.type === 'hello' && !key && !held && typeof m.key === 'string') {
          if (d.connect(m.key, send)) key = m.key
          else sock.destroy()
        } else if (m.type === 'permission' && key && typeof m.id === 'string') {
          d.permission(key, m.id)
        } else if ((m.type === 'mail' || m.type === 'wa' || m.type === 'voice') && key && typeof m.text === 'string') {
          routeReply(key, { type: m.type, text: m.text }, o)
        } else if (m.type === 'schedule' && key) {
          // Always for the session's own thread, whatever the message says.
          const j = m as Partial<{ id: string; cron: string; prompt: string; recurring: boolean }>
          if (typeof j.id === 'string' && typeof j.cron === 'string' && typeof j.prompt === 'string') {
            const no = o.schedules.add(key, { id: j.id, cron: j.cron, prompt: j.prompt, recurring: j.recurring !== false }, Date.now())
            if (no) log('schedule refused', key, no)
          }
        } else if (m.type === 'unschedule' && key && typeof m.id === 'string') {
          o.schedules.remove(key, m.id)
        }
      }
    })
    sock.on('close', () => {
      if (key) d.disconnect(key, send)
      if (held) { owned.delete(held); free(held) }
    })
    sock.on('error', () => {})
  })
  server.listen(path, () => chmodSync(path, 0o600))
  return server
}
