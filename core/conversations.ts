
export type Conversation = {
  connector: 'slack' | 'email' | 'whatsapp' | 'voice'
  chat: string
  thread?: string
  kind: 'dm' | 'group' | 'channel' | 'mail' | 'chat'
  agentDm?: true
}
export type Lane = 'main' | `side-${string}`

export function slackConversation(m: { channel: string; ts: string; thread_ts?: string; channel_type?: string }, botDm: string, kagePosted: (ts: string) => boolean): Conversation {
  const kind = m.channel_type === 'im' ? 'dm' : m.channel_type === 'mpim' ? 'group' : 'channel'
  if (m.channel === botDm && (!m.thread_ts || !kagePosted(m.thread_ts))) return { connector: 'slack', chat: m.channel, kind: 'dm', agentDm: true }
  return { connector: 'slack', chat: m.channel, thread: m.thread_ts ?? m.ts, kind }
}

export const jobLane = (key: string, id: string) => key.includes('#') ? key : `${key}#side-job-${id}`
export const isJobLane = (key: string) => key.includes('#side-job-')
export const threadOfJobLane = (key: string) => key.replace(/#side-job-[^#]*$/, '')
export const modelFor = (key: string, jobModel: string | null | undefined, other: (key: string) => string | undefined) => isJobLane(key) ? jobModel || undefined : other(key)

export function sessionKey(c: Conversation, o: { agent?: string; lane?: Lane } = {}): string {
  const base = c.connector === 'email' ? `mail:${c.chat}`
    : c.connector === 'whatsapp' ? `wa:${c.chat}`
    : c.connector === 'voice' ? `voice:${c.chat}`
    : c.agentDm ? 'dm' : `${c.chat}:${c.thread}`
  const lane = o.lane && o.lane !== 'main' ? `#${o.lane}` : ''
  return `${o.agent ? `${o.agent}/` : ''}${base}${lane}`
}

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
  else if (base.startsWith('voice:') && base.length > 6) conversation = { connector: 'voice', chat: base.slice(6), kind: 'chat' }
  else {
    const s = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(base)
    if (!s) return
    conversation = { connector: 'slack', chat: s[1]!, thread: s[2]!, kind: s[1]!.startsWith('D') ? 'dm' : 'channel' }
  }
  return { ...(agent && { agent }), ...(lane && { lane: lane as Lane }), conversation }
}

export function placeFor(placeOf: (key: string) => string | undefined, key: string): string {
  const m = KEY.exec(key)!
  return placeOf(key) ?? (m[1] || m[3] ? `${placeOf(m[2]!) ?? key}${m[3] ? ' (side)' : ''}` : key)
}

export function slackLinkKey(link: string): string | undefined {
  const url = URL.parse(link.trim())
  const m = url?.hostname.endsWith('.slack.com') ? /^\/archives\/([A-Z0-9]+)\/p(\d+)(\d{6})$/.exec(url.pathname) : null
  if (!url || !m) return
  const thread = url.searchParams.get('thread_ts') ?? `${m[2]}.${m[3]}`
  return /^\d+\.\d+$/.test(thread) ? `${m[1]}:${thread}` : undefined
}

export type ThreadRow = { key: string; place: string; chat: string | null; agent_dm: number | null }
export function matchThreads<R extends ThreadRow>(rows: R[], arg: string): R[] {
  const linked = slackLinkKey(arg)
  if (linked) {
    const own = rows.filter(r => r.key === linked || r.key.startsWith(`${linked}#`))
    return own.length ? own : rows.filter(r => r.agent_dm && linked.startsWith(`${r.chat}:`))
  }
  const want = arg.trim().toLowerCase()
  const exact = rows.filter(r => r.key === arg.trim())
  return exact.length ? exact : want ? rows.filter(r => r.place.toLowerCase().includes(want)) : []
}

export const filesFolderName = (channel: string, thread_ts: string) => `${channel}_${thread_ts}`.replace(/[^\w.-]/g, '_')
