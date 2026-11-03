// Where a message lives (a conversation), and the key of the session working on it. Connectors
// build conversations; the dispatcher and the store only ever see the key.

// chat: a Slack channel id, an email thread root, a WhatsApp chat id. thread: a Slack thread ts
// (a top-level channel message starts its own). agentDm: the top level of the owner's DM with the
// agent, which is one rolling conversation rather than a thread per message.
export type Conversation = {
  connector: 'slack' | 'email' | 'whatsapp'
  chat: string
  thread?: string
  kind: 'dm' | 'group' | 'channel' | 'mail' | 'chat'
  agentDm?: true
}
// A side lane is a second session on the same conversation, beside a busy main one.
export type Lane = 'main' | `side-${string}`

export function slackConversation(m: { channel: string; ts: string; thread_ts?: string; channel_type?: string }, botDm: string): Conversation {
  const kind = m.channel_type === 'im' ? 'dm' : m.channel_type === 'mpim' ? 'group' : 'channel'
  if (m.channel === botDm && !m.thread_ts) return { connector: 'slack', chat: m.channel, kind: 'dm', agentDm: true }
  return { connector: 'slack', chat: m.channel, thread: m.thread_ts ?? m.ts, kind }
}

// The default agent's keys are exactly the ones Kage has always used ("dm", "C1:5.5", "mail:<id>",
// "wa:<chat>"), so every saved thread keeps its session. Another agent's keys carry "<agent>/".
export function sessionKey(c: Conversation, o: { agent?: string; lane?: Lane } = {}): string {
  const base = c.connector === 'email' ? `mail:${c.chat}`
    : c.connector === 'whatsapp' ? `wa:${c.chat}`
    : c.agentDm ? 'dm' : `${c.chat}:${c.thread}`
  const lane = o.lane && o.lane !== 'main' ? `#${o.lane}` : ''
  return `${o.agent ? `${o.agent}/` : ''}${base}${lane}`
}

// The other way, for keys saved before conversations were stored. A key does not hold everything:
// "dm" needs the bot DM's id, and a Slack id tells a DM (D...) from the rest, not a group DM from a channel.
const KEY = /^(?:([a-z][a-z0-9-]{1,20})\/)?(.+?)(?:#(side-[^#]+))?$/
export function parseSessionKey(key: string, botDm = ''): { agent?: string; lane?: Lane; conversation: Conversation } | undefined {
  const m = KEY.exec(key)
  if (!m) return
  const [, agent, base = '', lane] = m
  if (key.includes('#') && !lane) return
  let conversation: Conversation
  if (base === 'dm') conversation = { connector: 'slack', chat: botDm, kind: 'dm', agentDm: true }
  else if (base.startsWith('mail:') && base.length > 5) conversation = { connector: 'email', chat: base.slice(5), kind: 'mail' }
  else if (base.startsWith('wa:') && base.length > 3) conversation = { connector: 'whatsapp', chat: base.slice(3), kind: 'chat' }
  else {
    const s = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(base)
    if (!s) return
    conversation = { connector: 'slack', chat: s[1]!, thread: s[2]!, kind: s[1]!.startsWith('D') ? 'dm' : 'channel' }
  }
  return { ...(agent && { agent }), ...(lane && { lane: lane as Lane }), conversation }
}
