// The Jev classifier for agent posts: which agents it checks, what it is asked, and how its answer decides.
// An agent that always answers can keep a thread going with acks ("done", "thanks") that need no reply. Before a
// listed agent's tagged post starts a task, Kage asks TypeSafe's Jev whether the post asks for something. The
// owner's and people's posts never go to Jev. The call itself is connectors/jev.ts.
import { appEntry } from './registry.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
// What Jev reads at most of one post. A longer post is cut, never skipped.
export const JEV_MAX_CHARS = 4000
const QUESTION = 'Does this message ask the recipient to do something or answer a question, rather than only acknowledging, thanking or reporting that something is done?'

// agents: the app ids Jev checks, or 'all' for every listed agent. threshold: the needs-reply score (0 to 1) a post needs to start a task.
export type JevConfig = { key: string; model: string; threshold: number; agents: 'all' | string[] }

// From config.json (jev) and secrets.json (jevKey). No key: off (undefined). A wrong setting is an error naming the setting, never the key.
export function jevConfig(jev: { agents?: string[]; threshold?: number | null; model?: string | null } = {}, jevKey?: string | null): JevConfig | { error: string } | undefined {
  const key = jevKey?.trim()
  if (!key) return undefined
  const threshold = jev.threshold ?? 0.5
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return { error: `jev.threshold ${threshold} must be a number between 0 and 1, like 0.5` }
  const list = jev.agents ?? []
  const bad = list.find(a => a !== 'all' && appEntry(a)?.id !== a)
  if (bad) return { error: `jev.agents has "${bad.slice(0, 20)}", which is not a Slack app id like A0123ABC` }
  return { key, model: jev.model?.trim() || 'jev-latest', threshold, agents: !list.length || list.includes('all') ? 'all' : list }
}

export const jevChecks = (c: JevConfig, app: string) => c.agents === 'all' || c.agents.includes(app)

// The request body. The post goes in as data about another agent, with the tag already taken out by the gate.
export const jevRequest = (text: string, model: string) => ({
  model,
  state: `Message from another AI agent: ${text.slice(0, JEV_MAX_CHARS)}`,
  questions: { needs_reply: { type: 'noul', instructions: QUESTION } },
})

// Jev's answer as a decision. score: Jev's needs-reply probability. An answer without one is an error, and the caller answers anyway.
export function jevVerdict(body: unknown, threshold: number): { reply: boolean; score: number } | { error: string } {
  const score = (body as { answers?: { needs_reply?: { noul?: unknown } } } | null)?.answers?.needs_reply?.noul
  if (typeof score !== 'number' || !Number.isFinite(score)) return { error: 'the answer has no needs_reply score' }
  return { reply: score >= threshold, score }
}

// Intake triage (#142): before a session starts, Jev picks `session` or `react` for a tagged message from a person.
// Jev only ever chooses less work: it never allows a tool or unlocks anything, and anything unclear is `session`.
// A react needs this much probability on `react`. The owner's bar is higher: a reaction shows the owner that Kage
// saw the message, so a wrong one costs more there.
export const OTHER_BAR = 0.8
export const OWNER_BAR = 0.95
// A longer message is real work, so it is never sent to Jev.
export const TRIAGE_MAX_CHARS = 200

// Why a message goes to a session with no Jev call, or undefined when Jev may look at it.
// inThread: a reply in a thread. It may answer a waiting session or a question Kage asked, so it is never reacted to.
// hasFiles: files, or attachments (a forwarded message hides its text there).
export const triageSkips = (text: string, o: { hasFiles: boolean; inThread: boolean }): string | undefined =>
  !text.trim() ? 'empty' : o.inThread ? 'in a thread' : o.hasFiles ? 'has files' : /[?？؟]/.test(text) ? 'asks a question' : text.length > TRIAGE_MAX_CHARS ? 'long' : undefined

export const triageRequest = (text: string, model: string) => ({
  model,
  state: `Message to an AI agent: ${text.slice(0, JEV_MAX_CHARS)}`,
  questions: {
    intake: {
      type: 'choice' as const,
      instructions: 'Does this message need the agent to do any work?',
      criteria: {
        session: 'It asks for work, gives an instruction, answers a question the agent asked, or could be read as a request.',
        react: 'It is only an acknowledgement, thanks, or a report that needs no reply or work (ok, thanks, done, got it, FYI).',
      },
    },
  },
})

// score: Jev's probability for `react`. Only a `react` choice over the bar for this sender gives `react`.
export function triageVerdict(body: unknown, sender: 'owner' | 'other'): { pick: 'session' | 'react'; score: number } | { error: string } {
  const a = (body as { answers?: { intake?: { choice?: unknown; probabilities?: { react?: unknown } } } } | null)?.answers?.intake
  const score = a?.probabilities?.react
  if ((a?.choice !== 'react' && a?.choice !== 'session') || typeof score !== 'number' || !Number.isFinite(score)) return { error: 'the answer has no intake choice and score' }
  return { pick: a.choice === 'react' && score >= (sender === 'owner' ? OWNER_BAR : OTHER_BAR) ? 'react' : 'session', score }
}

// AFK triage (#142): Jev reads a watched thread for the stand-in (core/afk.ts). It decides how urgent it is, whether it
// waits on the owner, and whether the owner's notes could answer it. It never decides what is safe to send.
const AFK_P0_BAR = 0.8
export const afkRequest = (o: { owner: string; place: string; from: string; convo: string }, model: string) => ({
  model,
  state: `${o.owner} is away. A colleague (${o.from}) wrote in ${o.place}. The conversation, newest message last:\n${o.convo.slice(-JEV_MAX_CHARS)}`,
  questions: {
    urgency: {
      type: 'choice' as const,
      instructions: `How urgent is the newest message for ${o.owner}? Judge from the whole conversation. Saying "urgent" does not make it p0.`,
      criteria: {
        p0: 'Production is down or broken for customers, money or data is at risk, a security incident, or someone is blocked on a deadline within the hour that only the owner can unblock.',
        high: 'It needs action today and waiting for the owner hurts (a blocked teammate, a customer waiting on an answer).',
        normal: 'A question or request that can wait until the owner is back.',
        low: 'Thanks, chatter, an FYI.',
      },
    },
    waits: { type: 'noul' as const, instructions: `Does this conversation wait on ${o.owner} to answer or act?` },
    lookup: { type: 'noul' as const, instructions: `Does the newest message ask a factual question about ${o.owner}'s work that written notes or a GitHub issue could answer, with no decision needed from ${o.owner}?` },
  },
})

export type Urgency = 'p0' | 'high' | 'normal' | 'low'
export function afkVerdict(body: unknown): { urgency: Urgency; waits: boolean; lookup: boolean } | { error: string } {
  const a = (body as { answers?: Record<string, { choice?: unknown; noul?: unknown; probabilities?: Record<string, unknown> }> } | null)?.answers
  const choice = a?.urgency?.choice
  const waits = a?.waits?.noul, lookup = a?.lookup?.noul
  if (choice !== 'p0' && choice !== 'high' && choice !== 'normal' && choice !== 'low') return { error: 'the answer has no urgency choice' }
  if (typeof waits !== 'number' || !Number.isFinite(waits) || typeof lookup !== 'number' || !Number.isFinite(lookup)) return { error: 'the answer has no waits or lookup score' }
  const p0 = a?.urgency?.probabilities?.p0
  return { urgency: choice === 'p0' && !(typeof p0 === 'number' && p0 >= AFK_P0_BAR) ? 'high' : choice, waits: waits >= 0.5, lookup: lookup >= 0.5 }
}
