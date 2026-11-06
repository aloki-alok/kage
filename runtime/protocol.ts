// What the hub and a thread's session say to each other over the local socket, one JSON object per line.

// Every connector (Slack, email, WhatsApp, voice) turns what it heard into this one shape. meta goes to Claude as
// the <channel> tag's attributes; origin is the message to mark when the task is picked up or fails.
// meta.channel is a Slack channel id for Slack, and the connector's name ("email", "whatsapp", "voice")
// for the rest; thread_ts is a Slack thread ts, or the session key for the rest. origin.ts is ''
// for a scheduled run, which has no message to mark.
export type Task = {
  type: 'task'
  content: string
  fromOwner: boolean
  meta: { channel: string; thread_ts: string; place: string; permalink: string }
  origin: { channel: string; ts: string }
  scheduled?: true   // Kage started it itself (a schedule, dream), so it answers no open question
}
export type Verdict = { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
export type ToSession = Task | Verdict

// Session to hub: hello (which thread it serves), an open approval, an email, WhatsApp or voice reply for its own chat.
// hold comes from `kage attach` instead: the owner takes the thread into a terminal until it disconnects.
// The hub answers it with { type: 'hold', id } or { type: 'hold', refused }.
// board and stop come from `kage top` the same way: the hub answers { type: 'board', ...status } and
// { type: 'stop', ok: true } or { type: 'stop', refused }.
export type FromSession =
  | { type: 'board' }
  | { type: 'callcode' }   // kage call: the hub answers { type: 'callcode', code } or { type: 'callcode', refused }
  | { type: 'stop'; key: string }
  | { type: 'tell'; key: string; text: string }   // kage tell: the hub answers { type: 'tell', ok: true } or { type: 'tell', refused }
  | { type: 'hold'; key: string; pid: number }   // pid: the attach process, which owns the hold
  | { type: 'hello'; key: string }
  | { type: 'permission'; id: string }
  | { type: 'mail'; text: string }
  | { type: 'schedule'; id: string; cron: string; prompt: string; recurring: boolean }   // its own thread; the hub decides trust
  | { type: 'unschedule'; id: string }
  | { type: 'wa'; text: string }
  | { type: 'voice'; text: string }
