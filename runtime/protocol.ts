// What the hub and a thread's session say to each other over the local socket, one JSON object per line.
import type { PanelAction } from '../core/kagelet-view.ts'
import type { Task } from '../core/task.ts'
import type { ProbeArg } from './probe-jobs.ts'

export type Verdict = { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
export type ToSession = Task | Verdict

// Session to hub: hello (which thread it serves), an open approval, an email, WhatsApp or voice reply for its own chat.
// hold comes from `kage attach` instead: the owner takes the thread into a terminal until it disconnects.
// The hub answers it with { type: 'hold', id } or { type: 'hold', refused }.
// board and stop come from `kage top` the same way: the hub answers { type: 'board', ...status } and
// { type: 'stop', ok: true } or { type: 'stop', refused }.
export type FromSession =
  | { type: 'board' }
  | { type: 'end'; key: string; cut?: boolean }   // kage stop <thread>: the hub answers { type: 'end', text }
  | { type: 'quiesce' }   // kage restart and stop: the hub drains for 10 s and answers { type: 'quiesce', waiting: [{ key, why }] }
  | { type: 'reload' }   // kage reload: the hub answers { type: 'reload', changed, restart, count } or { type: 'reload', refused }
  | { type: 'callcode' }   // kage call: the hub answers { type: 'callcode', code } or { type: 'callcode', refused }
  | { type: 'stop'; key: string }
  | { type: 'kagelet'; action: PanelAction; name: string }   // kage top's panel: the hub answers { type: 'kagelet', text } or { type: 'kagelet', refused }
  | { type: 'tell'; key: string; text: string }   // kage tell: the hub answers { type: 'tell', ok: true } or { type: 'tell', refused }
  // kage say, from an app on this Mac: no channel starts a new message in the DM with Kage; channel and thread_ts reply in
  // that DM or a thread Kage works in. Posted as the owner, run as their task. The hub answers { type: 'say', ok: true, channel, ts } or { type: 'say', refused }.
  | { type: 'say'; text: string; channel?: string; thread_ts?: string }
  | { type: 'relay'; action: 'allow' | 'deny' | 'list'; key?: string }   // kage relay: the hub answers { type: 'relay', ok: true, keys } or { type: 'relay', refused }
  | { type: 'hold'; key: string; pid: number }   // pid: the attach process, which owns the hold
  | { type: 'hello'; key: string }
  | { type: 'permission'; id: string }
  | { type: 'mail'; text: string }
  | { type: 'schedule'; id: string; cron: string; prompt: string; recurring: boolean; probe?: ProbeArg; shadow?: { of: string; live: string } }   // its own thread; the hub decides trust
  | { type: 'unschedule'; id: string }
  | { type: 'wa'; text: string }
  | { type: 'voice'; text: string }
