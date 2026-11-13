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
  return { name, key: `${thread}#spec-${name}`, cron, tools, job }
}

// The grant only shrinks: a tool outside it is denied. Kage's own tools stay, so it can answer in its thread.
export const grantRefusal = (tool: string, grant: string[]) =>
  grant.includes(tool) || tool.startsWith('mcp__kage__') ? undefined
    : `${tool} is outside this specialist's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
