// Hook rules inside a Kage session that read only the tool name and the sender: private sources, voice calls, Slack posts. The rules that compare real paths on disk are runtime/path-guards.ts.
import { dirname } from 'node:path'

// Sources that hold the owner's private data. Only the owner's own task may read them.
// browser_: Kage's own tools on the owner's Chrome, where every tab carries their logins (#114).
export const ownerOnlyTool = (tool: string) => /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies|kage_?_browser_)/i.test(tool)
export function privateToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (!ownerOnlyTool(tool) || sender === 'owner') return undefined
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
// Any MCP server is the owner's unless they share it: a task not from the owner gets Kage's own tools and the
// prefixes in sharedTools (config.json), so a server added later stays closed until the owner lists it (#271).
const OWN_TOOLS = /^mcp__(kage|plugin_kage_kage)__/
// A claude.ai connector runs as the owner's own login on that service, so listing it cannot share it.
const OWNER_ACCOUNT = /^mcp__claude_ai_/
export function mcpToolRefusal(tool: string, sender: string | undefined, shared: readonly string[] = []): string | undefined {
  if (sender === 'owner' || !tool.startsWith('mcp__') || OWN_TOOLS.test(tool)) return undefined
  if (OWNER_ACCOUNT.test(tool)) return `${tool} acts as the owner's own account, so only the owner's task may use it. Do the task with your other tools, or reply that this part needs the owner.`
  if (shared.some(p => tool.startsWith(p))) return undefined
  return `${tool} is not among the tools the owner shares with other people's tasks (sharedTools). Reply that this needs the owner, and stop.`
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
// Kage's own memory (hub.ts points autoMemoryDirectory at it) and the owner's, which is the
// memory of the home folder project in Claude Code.
export const memoryDirs = (home: string, envFile: string, harness: { memory?: string | null; ownerMemory?: string | null } = {}) => ({
  own: harness.memory || `${dirname(envFile)}/memory`,
  owner: harness.ownerMemory || `${home}/.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/memory`,
})
// Where the server records who sent a thread's latest task, for the private-data hook.
export const senderFile = (dir: string, thread: string) => `${dir}/sender/${thread.replace(/[^A-Za-z0-9.]/g, '_')}`
