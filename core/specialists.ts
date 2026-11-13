// Specialists (#57): one file each in the specialists folder, run on a schedule in a side lane of its thread, at
// teammate trust, with only the tools its grant names. A specialist approves nothing: what needs approval it says in
// its thread, where its manager (this Kage) and the human owner read it.
import { resolve } from 'node:path'
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
const WRITES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
// The grant only shrinks: a tool outside it is denied. A specialist can never widen it: it gets no shell, and no
// writes in Kage's config folder, which holds its own file, the env file and the store.
export function grantRefusal(tool: string, grant: string[], input: Record<string, unknown> = {}, confDir = '') {
  if (tool === 'Bash') return 'A specialist gets no shell, granted or not: a shell could change its own grant.'
  // Resolved, so ../ cannot step into the folder. ponytail: a symlink out of the work folder still could; deny writes everywhere if that bites.
  const path = resolve(String(input.file_path ?? input.notebook_path ?? ''))
  if (confDir && WRITES.includes(tool) && (path === confDir || path.startsWith(`${confDir}/`))) return `A specialist may not write in Kage's config folder (${confDir}).`
  return THREAD_TOOLS.includes(tool) || (grant.includes(tool) && !tool.startsWith('mcp__kage__')) ? undefined
    : `${tool} is outside this specialist's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
}
