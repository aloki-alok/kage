// Hook rules inside a Kage session: private sources, the owner's memory, the sender file.
import { resolve } from 'node:path'

// Sources that hold the owner's private data. Only the owner's own task may read them.
const PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies)/i
export function privateToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (!PRIVATE_TOOL.test(tool) || sender === 'owner') return undefined
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
// Kage's own memory (start.sh points autoMemoryDirectory at it) and the owner's, which is the
// memory of the home folder project in Claude Code.
export const memoryDirs = (home: string, envFile: string, env: Record<string, string | undefined>) => ({
  own: env.KAGE_MEMORY || `${envFile.replace(/\/[^/]*$/, '')}/memory`,
  owner: env.KAGE_OWNER_MEMORY || `${home}/.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/memory`,
})
// Kage keeps its own memory; in the owner's it may write only notes about people (user_*.md) and
// edit the index that lists them. ponytail: covers the file tools, not a shell redirect into the
// folder; add a Bash check if a session is ever seen writing there that way.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export function ownerMemoryRefusal(tool: string, input: { file_path?: string }, ownerMemory: string): string | undefined {
  if (!WRITE_TOOLS.has(tool) || !input.file_path) return
  const file = resolve(input.file_path)
  const dir = resolve(ownerMemory)
  if (!file.startsWith(`${dir}/`)) return
  const name = file.slice(dir.length + 1)
  if (/^user_[\w-]+\.md$/.test(name) || (name === 'MEMORY.md' && tool !== 'Write')) return
  return `The owner's memory takes only people notes (user_<name>.md) from you. Save your own lessons in your own memory folder.`
}
// Where the server records who sent a thread's latest task, for the private-data hook.
export const senderFile = (dir: string, thread: string) => `${dir}/sender/${thread.replace(/[^A-Za-z0-9.]/g, '_')}`
