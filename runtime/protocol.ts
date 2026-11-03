// What the hub and a thread's session say to each other over the local socket, one JSON object per line.

// Every connector (Slack, email) turns what it heard into this one shape. meta goes to Claude as
// the <channel> tag's attributes; origin is the message to mark when the task is picked up or fails.
export type Task = {
  type: 'task'
  content: string
  fromOwner: boolean
  meta: { channel: string; thread_ts: string; place: string; permalink: string }
  origin: { channel: string; ts: string }
}
export type Verdict = { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
export type ToSession = Task | Verdict

// Session to hub: hello (which thread it serves), an open approval, an email reply for its thread.
export type FromSession =
  | { type: 'hello'; key: string }
  | { type: 'permission'; id: string }
  | { type: 'mail'; text: string }
