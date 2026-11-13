// Specialists (#57): one file each in the specialists folder, run on a schedule in a side lane of its thread, at
// teammate trust, with only the tools its grant names. A specialist approves nothing: what needs approval it says in
// its thread, where its manager (this Kage) and the human owner read it.
import { parseCron } from './cron.ts'
import { slackLinkKey } from './conversations.ts'

export type Specialist = { name: string; key: string; cron: string; tools: string[]; job: string }

// Flat front matter (key: value lines between --- lines), then the job.
export function parseSpecialist(name: string, text: string): Specialist | { error: string } {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return { error: `the file name "${name}" must be a short lowercase name: letters, digits, dashes` }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { error: 'it needs front matter between --- lines: thread, schedule, tools' }
  const head = new Map(m[1]!.split('\n').map(l => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(x => !!x).map(x => [x[1]!, x[2]!.trim()]))
  const thread = slackLinkKey(head.get('thread') ?? '')
  if (!thread) return { error: 'thread must be a Slack message link ("Copy link" in Slack)' }
  const cron = head.get('schedule') ?? ''
  try { parseCron(cron) } catch { return { error: `schedule must be a cron line like "0 9 * * 1-5", not "${cron}"` } }
  const job = m[2]!.trim()
  if (!job) return { error: 'the job, below the front matter, is empty' }
  const tools = (head.get('tools') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  return { name, key: `${thread}#side-spec-${name}`, cron, tools, job }
}

// Of Kage's own tools, a specialist has only those for its thread, whatever its grant says: the rest act as the
// owner (message_people, away), outlive the run (schedule) or need the owner (log_prod_write).
const THREAD_TOOLS = ['reply', 'edit_message', 'delete_message'].map(t => `mcp__kage__${t}`)
// What a grant may name: web tools and outside MCP tools, an allowlist so a new built-in tool stays out. No file,
// shell or agent tool, granted or not: one could rewrite the specialist's own grant or read the env file with the
// tokens. ponytail: a file grant needs a sandboxed work folder first.
const grantable = (t: string) => t === 'WebFetch' || t === 'WebSearch' || (t.startsWith('mcp__') && !t.startsWith('mcp__kage__') && !t.startsWith('mcp__plugin_kage_'))

// The grant only shrinks: a tool outside it is denied.
export function grantRefusal(tool: string, grant: string[], input: Record<string, unknown> = {}) {
  if (THREAD_TOOLS.includes(tool)) return undefined
  if (!grantable(tool)) return `A specialist can be granted only web and MCP tools, not ${tool}. Say in the thread what you needed: your manager decides.`
  if (tool === 'WebFetch' && !/^https?:\/\//i.test(String(input.url ?? ''))) return 'A specialist fetches only http and https addresses.'
  return grant.includes(tool) ? undefined
    : `${tool} is outside this specialist's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
}
