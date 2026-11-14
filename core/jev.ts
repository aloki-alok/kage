// The Jev classifier for agent posts: which agents it checks, what it is asked, and how its answer decides.
// An agent that always answers can keep a thread going with acks ("done", "thanks") that need no reply. Before a
// listed agent's tagged post starts a task, Kage asks TypeSafe's Jev whether the post asks for something. The
// owner's and people's posts never go to Jev. The call itself is connectors/jev.ts.
import { appEntry } from './registry.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
// What Jev reads at most of one post. A longer post is cut, never skipped.
export const JEV_MAX_CHARS = 4000
export const QUESTION = 'Does this message ask the recipient to do something or answer a question, rather than only acknowledging, thanking or reporting that something is done?'

// agents: the app ids Jev checks, or 'all' for every listed agent. threshold: the needs-reply score (0 to 1) a post needs to start a task.
export type JevConfig = { key: string; model: string; threshold: number; agents: 'all' | string[] }

// From the env file. No JEV_API_KEY: off (undefined). A wrong setting is an error naming the setting, never the key.
export function jevConfig(env: Record<string, string | undefined>): JevConfig | { error: string } | undefined {
  const key = env.JEV_API_KEY?.trim()
  if (!key) return undefined
  const t = env.KAGE_JEV_THRESHOLD?.trim()
  const threshold = t ? Number(t) : 0.5
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return { error: `KAGE_JEV_THRESHOLD "${t}" must be a number between 0 and 1, like 0.5` }
  const list = (env.KAGE_JEV_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean)
  const bad = list.find(a => a !== 'all' && appEntry(a)?.id !== a)
  if (bad) return { error: `KAGE_JEV_AGENTS has "${bad.slice(0, 20)}", which is not a Slack app id like A0123ABC` }
  return { key, model: env.KAGE_JEV_MODEL?.trim() || 'jev-latest', threshold, agents: !list.length || list.includes('all') ? 'all' : list }
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
