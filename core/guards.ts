// Hook rules inside a Kage session: private sources, the owner's memory, the sender file.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// Sources that hold the owner's private data. Only the owner's own task may read them.
const PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies)/i
export function privateToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (!PRIVATE_TOOL.test(tool) || sender === 'owner') return undefined
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
// A voice call may be anyone, and its session holds the owner's memory in context, so it gets its
// reply tool and nothing else: no shell, no files, no web (a URL can carry that context out), no
// posting, no schedules, no other MCP tools. Its approval prompts never reach the owner either.
const VOICE_OK = new Set(['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'ToolSearch'])   // the reply tool (dev-route and plugin-route names), and ToolSearch, which loads it when deferred
export function voiceToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (sender !== 'voice' || VOICE_OK.has(tool)) return undefined
  return `${tool} is not allowed on a voice call: anyone may be talking. Answer from what you know, or say you will check with the owner.`
}
// A listed agent's task may read and answer, nothing more. An agent relays what it read elsewhere (an
// email, a page, a ticket), so its task is where injected instructions arrive. It gets no shell, no edits,
// no web (a URL can carry data out), no other MCP tool, no subagent, no posting as the owner and no
// schedule, and it never puts an approval card in front of the owner: a card relayed by an agent is how
// an injected instruction would get approved. Reads skip the places that hold secrets.
const AGENT_OK = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite',
  'mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__plugin_kage_kage__reply', 'mcp__plugin_kage_kage__edit_message'])
const SECRET_DIRS = ['.config/kage', '.ssh', '.aws', '.claude', '.gnupg', '.docker', '.kube']
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pgpass|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx))$/i
// A Glob pattern that would list secret files: it names .env, a key or a secret folder anywhere in it.
const SECRET_GLOB = /(^|[/*{,])(\.env|\.netrc|\.npmrc|\.pgpass|id_[a-z0-9*]|\.ssh|\.aws|\.gnupg|\.claude|\.config\/kage)|\.(pem|key|p12|pfx)\b/i
export function agentToolRefusal(tool: string, input: { file_path?: string; path?: string; pattern?: string }, sender: string | undefined, home = process.env.HOME ?? ''): string | undefined {
  if (sender !== 'agent') return undefined
  if (!AGENT_OK.has(tool)) return `${tool} is not allowed on an agent's task: it may only read and answer. Say in the thread what it would need, and that a person has to ask for it.`
  const target = tool === 'Read' ? input.file_path : tool === 'Grep' || tool === 'Glob' ? (input.path ?? home) : undefined
  if (!target) return undefined
  // Both sides resolved, so a home folder behind a symlink (macOS /var -> /private/var) compares like for like.
  const base = real(home), full = real(resolve(home, target)), glob = tool === 'Glob' ? String(input.pattern ?? '') : ''
  const secret = SECRET_DIRS.some(d => { const dir = join(base, d); return full === dir || full.startsWith(dir + '/') || (full === base && glob.includes(d)) })
    || SECRET_FILE.test(full) || SECRET_GLOB.test(glob)
  return secret ? `${target} may hold secrets, and an agent's task does not read them.` : undefined
}
// The path as the file system has it, so a symlink can't point a read at a secret.
// A path that does not exist yet resolves through its deepest existing folder, so it still compares like for like.
function real(p: string): string {
  try { return realpathSync(p) } catch {}
  const up = dirname(p)
  return up === p ? p : join(real(up), basename(p))
}

// A Slack connector posts as the owner with no sign of Kage. Kage's reply and message_people tools
// post as Kage, or mark a post from the owner's account, so every Slack post goes through them.
// Any Slack server's tool that sends, posts, schedules or replies; drafts post nothing.
const SLACK_SEND = /^mcp__[^_]*.*slack.*__.*(send|post|schedule|reply|add_message)/i
export function slackSendRefusal(tool: string): string | undefined {
  if (!SLACK_SEND.test(tool) || /draft/i.test(tool)) return undefined
  return `${tool} posts as the owner with no sign of Kage. Use the reply tool for this thread, or message_people to tell someone else.`
}
// Kage's own memory (hub.ts points autoMemoryDirectory at it) and the owner's, which is the
// memory of the home folder project in Claude Code.
export const memoryDirs = (home: string, envFile: string, env: Record<string, string | undefined>) => ({
  own: env.KAGE_MEMORY || `${dirname(envFile)}/memory`,
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
