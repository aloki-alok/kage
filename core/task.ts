// A message turned into work for a session. Every connector (Slack, email, WhatsApp, voice) turns what it heard into this one shape. meta goes to Claude as
// the <channel> tag's attributes; origin is the message to mark when the task is picked up or fails.
// meta.channel is a Slack channel id for Slack, and the connector's name ("email", "whatsapp", "voice")
// for the rest; thread_ts is a Slack thread ts, or the session key for the rest. origin.ts is ''
// for a scheduled run, which has no message to mark.
// ADR 0002: connectors build it, core decides who may drive Kage.
export type Task = {
  type: 'task'
  content: string
  fromOwner: boolean
  meta: { channel: string; thread_ts: string; place: string; permalink: string }
  origin: { channel: string; ts: string; thread?: string }   // thread: the Slack thread the message sits in, when it is a reply
  source?: string    // the inbox message it came from, when not Slack's (runtime/limit-pause.ts holds it for a replay)
  job?: string       // the schedule this run belongs to (runtime/scheduler.ts)
  agent?: { app: string; tag?: string }   // a listed agent posted it (core/agents.ts); tag: its Slack user id, when the registry has it
  scheduled?: true   // Kage started it itself (a schedule, dream), so it answers no open question
  // A kagelet message this run carries (runtime/kagelets.ts kageletRoutes): its chain, its id, which only this
  // turn's normal end acknowledges, and its hop count.
  handoff?: { chain: string; message: string; hops: number }
  need?: { name: string; id: string }   // the kagelet need this run handles (runtime/kagelet-needs.ts): its words are data, and only a normal end settles it
}
