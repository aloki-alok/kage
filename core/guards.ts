// Hook rules inside a Kage session: private sources, the owner's memory, the sender file.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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
// folder, so it stops mistakes, not a determined session; add a Bash check if one is ever seen
// writing there that way. Hooks load only on the plugin route (hooks/hooks.json).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export function ownerMemoryRefusal(
  tool: string, input: { file_path?: string; notebook_path?: string }, ownerMemory: string, home = process.env.HOME ?? '',
): string | undefined {
  const raw = input.file_path ?? input.notebook_path
  if (!WRITE_TOOLS.has(tool) || !raw) return
  // Compare real paths, lowercased: links are followed, and macOS treats Memory and memory alike.
  const file = realish(raw.replace(/^~(?=\/)/, home))
  const dir = realish(ownerMemory)
  if (!file.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return
  const name = file.slice(dir.length + 1)
  if (/^user_[\w-]+\.md$/.test(name) || (name === 'MEMORY.md' && tool !== 'Write')) return
  return `The owner's memory takes only people notes (user_<name>.md) from you. Save your own lessons in your own memory folder.`
}

// The real path of p, or of its nearest existing parent with the rest appended (a new file has no real path yet).
function realish(p: string): string {
  const rest: string[] = []
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest) } catch {}
    if (dirname(cur) === cur) return resolve(p)
    rest.unshift(basename(cur))
  }
}
// Where the server records who sent a thread's latest task, for the private-data hook.
export const senderFile = (dir: string, thread: string) => `${dir}/sender/${thread.replace(/[^A-Za-z0-9.]/g, '_')}`
