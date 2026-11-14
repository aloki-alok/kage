// Hook rules inside a Kage session: private sources, the owner's memory, the sender file.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// Sources that hold the owner's private data. Only the owner's own task may read them.
// browser_: Kage's own tools on the owner's Chrome, where every tab carries their logins (#114).
const PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies|kage_?_browser_)/i
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
// A Slack connector posts as the owner with no sign of Kage. Kage's reply and message_people tools
// post as Kage, or mark a post from the owner's account, so every Slack post goes through them.
// Any Slack server's tool that sends, posts, schedules or replies; drafts post nothing.
const SLACK_SEND = /^mcp__[^_]*.*slack.*__.*(send|post|schedule|reply|add_message)/i
export function slackSendRefusal(tool: string): string | undefined {
  if (!SLACK_SEND.test(tool) || /draft/i.test(tool)) return undefined
  return `${tool} posts as the owner with no sign of Kage. Use the reply tool for this thread, or message_people to tell someone else.`
}
// The config folder holds the Slack, AWS and voice tokens. Only the owner's task may touch it: their sessions source
// the env file to post as the bot or read Slack when the connector fails. Anyone else's task never needs it.
// Its files/ (each thread's files, for send_file and reports) and memory/ (Kage's own lessons) stay open.
// ponytail: a path match, so a deliberately hidden path (quotes, globs, a search from a parent folder) gets past;
// the outbound secret filter (core/outbound.ts) still stops a token from being posted. Upgrade: a sandbox without it.
const CONFIG_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
const NOT_PATHS = new Set(['content', 'old_string', 'new_string', 'new_source', 'description', 'edits'])
export function configRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, envFile: string, home = process.env.HOME ?? ''): string | undefined {
  if (sender === 'owner' || !CONFIG_TOOLS.has(tool)) return
  const dir = dirname(envFile)
  // The forms a model types: absolute, the real path, ~, $HOME, and relative to the home folder sessions start in.
  const forms = [...new Set([dir, realish(dir), dir.startsWith(`${home}/`) ? dir.slice(home.length + 1) : ''])].filter(Boolean)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = Object.entries(input).filter(([k, v]) => !NOT_PATHS.has(k) && typeof v === 'string').map(([, v]) => v as string)
    .map(v => v.replace(/(^|[\s'"=:])~(?=\/)/g, `$1${home}`).replace(/\$\{?HOME\}?/g, home))
  // The folder itself, ended by a path or word boundary, unless it goes on into files/ or memory/ with no "..".
  const hit = (v: string) => forms.some(f => [...v.matchAll(new RegExp(`${esc(f)}(?![\\w.-])(/(?:files|memory)(?=/|$|[\\s'"])[^\\s'"]*)?`, 'g'))]
    .some(m => !m[1] || m[1].includes('..')))
  if (!named.some(hit)) return
  return `Kage's config folder holds its tokens, and this task did not come from the owner. Reply that this needs the owner, and stop.`
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
