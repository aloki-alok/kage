import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { ProbeArg } from './probe-jobs.ts'
import { dirname, join } from 'node:path'
import type { LimitCounts } from '../core/board.ts'
import { PANEL_KEYS, type PanelAction } from '../core/kagelet-view.ts'
import type { Dispatcher } from '../core/sessions.ts'
import type { Reloaded } from '../core/settings.ts'
import { isJobLane } from '../core/conversations.ts'
import { log } from './log.ts'
import type { FromSession, ToSession } from './protocol.ts'
import type { scheduler } from './scheduler.ts'

type Replies = { mail: (key: string, text: string) => void; wa: (key: string, text: string) => void; voice: (key: string, text: string) => void }

export function routeReply(key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }, o: Replies) {
  if (m.type === 'mail' && key.startsWith('mail:')) o.mail(key, m.text)
  else if (m.type === 'wa' && key.startsWith('wa:')) o.wa(key, m.text)
  else if (m.type === 'voice' && key.startsWith('voice:')) o.voice(key, m.text)
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

export function listenForSessions(path: string, d: Dispatcher<ToSession>, o: Replies & {
  failed: (m: ToSession) => void
  schedules: Pick<ReturnType<typeof scheduler>, 'add' | 'remove'>
  callCode?: () => string
  tell?: (key: string, text: string) => { ok: true; held?: true } | { refused: string }
  say?: (text: string, at?: { channel: string; thread_ts: string }) => Promise<{ ok: true; channel: string; ts: string } | { refused: string }>
  relay?: (action: string, key?: string) => { ok: true; keys: string[] } | { refused: string }
  reload?: () => Reloaded
  paused?: () => { until: number; held: number } | undefined
  limitCounts?: () => LimitCounts
  quiesce?: () => { key: string; why: string }[]
  end?: (key: string, cut: boolean) => string
  kagelet?: (action: PanelAction, name: string) => Promise<string>
}) {
  try { unlinkSync(path) } catch {}
  const dir = dirname(path)
  const owned = new Set<string>()
  const free = (key: string) => {
    rmSync(holdFile(dir, key), { force: true })
    d.release(key, Date.now()).forEach(o.failed)
  }
  setInterval(() => {
    for (const key of heldKeys(dir)) if (!owned.has(key) && !alive(holderOf(dir, key))) free(key)
  }, 5000).unref()
  const server = createServer(sock => {
    let key = ''
    let held = ''
    let buf = ''
    const send = (m: ToSession) => sock.write(JSON.stringify(m) + '\n')
    sock.on('data', chunk => {
      buf += chunk
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: Partial<FromSession> & { key?: unknown; id?: unknown; text?: unknown; pid?: unknown; name?: unknown }
        try { m = JSON.parse(line) } catch { continue }
        if (!m || typeof m !== 'object') continue
        if (m.type === 'hold' && !key && !held && typeof m.key === 'string') {
          const pid = typeof m.pid === 'number' ? m.pid : 0
          let r = d.hold(m.key)
          if ('refused' in r && r.refused === 'held' && !owned.has(m.key) && alive(pid) && holderOf(dir, m.key) === pid) r = { id: d.saved()[m.key]! }
          if ('id' in r) {
            held = m.key
            owned.add(held)
            mkdirSync(join(dir, 'held'), { recursive: true, mode: 0o700 })
            writeFileSync(holdFile(dir, held), String(pid), { mode: 0o600 })
          }
          sock.write(JSON.stringify({ type: 'hold', ...r }) + '\n')
        } else if (m.type === 'board' && !key && !held) {
          const paused = o.paused?.()
          const limitCounts = o.limitCounts?.()
          sock.write(JSON.stringify({ type: 'board', ...d.status(Date.now()), ...(paused && { paused }), ...(limitCounts && { limitCounts }) }) + '\n')
        } else if (m.type === 'end' && !key && !held && o.end && typeof m.key === 'string') {
          sock.write(JSON.stringify({ type: 'end', text: o.end(m.key, (m as { cut?: unknown }).cut === true) }) + '\n')
        } else if (m.type === 'quiesce' && !key && !held && o.quiesce) {
          sock.write(JSON.stringify({ type: 'quiesce', waiting: o.quiesce() }) + '\n')
        } else if (m.type === 'reload' && !key && !held) {
          sock.write(JSON.stringify({ type: 'reload', ...(o.reload?.() ?? { refused: 'this hub cannot reload' }) }) + '\n')
        } else if (m.type === 'callcode' && !key && !held) {
          const code = o.callCode?.()
          sock.write(JSON.stringify({ type: 'callcode', ...(code ? { code } : { refused: 'voice is off' }) }) + '\n')
        } else if (m.type === 'tell' && !key && !held && typeof m.key === 'string' && typeof m.text === 'string') {
          const r = !m.text.trim() ? { refused: 'empty message' } : o.tell?.(m.key, m.text.trim()) ?? { refused: 'this hub cannot take messages' }
          sock.write(JSON.stringify({ type: 'tell', ...r }) + '\n')
        } else if (m.type === 'say' && !key && !held && typeof m.text === 'string') {
          const at = m as { channel?: unknown; thread_ts?: unknown }
          const answer = (r: object) => sock.write(JSON.stringify({ type: 'say', ...r }) + '\n')
          const text = m.text.trim()
          if (!text) answer({ refused: 'empty message' })
          else if (typeof at.channel === 'string' !== (typeof at.thread_ts === 'string')) answer({ refused: 'a reply needs both channel and thread_ts' })
          else if (!o.say) answer({ refused: 'this hub cannot post' })
          else void o.say(text, typeof at.channel === 'string' ? { channel: at.channel, thread_ts: at.thread_ts as string } : undefined).then(answer)
        } else if (m.type === 'relay' && !key && !held) {
          const r = typeof m.action === 'string' && ['allow', 'deny', 'list'].includes(m.action) ? o.relay?.(m.action, typeof m.key === 'string' ? m.key : undefined) ?? { refused: 'this hub has no relay' } : { refused: 'use allow, deny or list' }
          sock.write(JSON.stringify({ type: 'relay', ...r }) + '\n')
        } else if (m.type === 'kagelet' && !key && !held && typeof m.name === 'string') {
          const action = (m as { action?: unknown }).action as PanelAction
          const answer = (r: { text: string } | { refused: string }) => sock.write(JSON.stringify({ type: 'kagelet', ...r }) + '\n')
          if (!Object.values(PANEL_KEYS).includes(action)) answer({ refused: `kage top runs, pauses, resumes or removes a kagelet, or revokes the standing approval, not ${String(action)}` })
          else if (!o.kagelet) answer({ refused: 'this hub cannot act on kagelets' })
          else void o.kagelet(action, m.name).then(text => answer({ text }), (e: Error) => answer({ refused: e.message }))
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
          const j = m as Partial<{ id: string; cron: string; prompt: string; recurring: boolean; lane: boolean; probe: ProbeArg; shadow: { of: string; live: string } }>
          if (typeof j.id === 'string' && typeof j.cron === 'string' && typeof j.prompt === 'string') {
            const no = o.schedules.add(key, { id: j.id, cron: j.cron, prompt: j.prompt, recurring: j.recurring !== false, ...(typeof j.lane === 'boolean' && { lane: j.lane ? true as const : undefined }), ...(j.probe && { probe: j.probe }), ...(typeof j.shadow?.of === 'string' && typeof j.shadow.live === 'string' && { shadow: { of: j.shadow.of, live: j.shadow.live } }) }, Date.now())
            if (no) log('schedule refused', key, no)
          }
        } else if (m.type === 'unschedule' && key && typeof m.id === 'string') {
          if (isJobLane(key)) log('unschedule refused in a job lane', key); else o.schedules.remove(key, m.id)
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
