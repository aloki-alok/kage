import { dirname } from 'node:path'

export const ownerOnlyTool = (tool: string) => /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies|kage_?_browser_|kage_?_slack_(search|read)$)/i.test(tool)
export function privateToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (!ownerOnlyTool(tool) || sender === 'owner' || sender === 'trusted') return undefined
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
const OWN_TOOLS = /^mcp__(kage|plugin_kage_kage)__/
const OWNER_ACCOUNT = /^mcp__claude_ai_/
export function mcpToolRefusal(tool: string, sender: string | undefined, shared: readonly string[] = []): string | undefined {
  if (sender === 'owner' || sender === 'trusted' || !tool.startsWith('mcp__') || OWN_TOOLS.test(tool)) return undefined
  if (OWNER_ACCOUNT.test(tool)) return `${tool} acts as the owner's own account, so only the owner's task may use it. Do the task with your other tools, or reply that this part needs the owner.`
  if (shared.some(p => tool.startsWith(p))) return undefined
  return `${tool} is not among the tools the owner shares with other people's tasks (sharedTools). Reply that this needs the owner, and stop.`
}
const VOICE_OK = new Set(['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'ToolSearch'])
export function voiceToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (sender !== 'voice' || VOICE_OK.has(tool)) return undefined
  return `${tool} is not allowed on a voice call: anyone may be talking. Answer from what you know, or say you will check with the owner.`
}
const AGENT_OK = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite',
  'mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__plugin_kage_kage__reply', 'mcp__plugin_kage_kage__edit_message'])
export const SECRET_DIRS = ['.config/kage', '.ssh', '.aws', '.claude', '.gnupg', '.docker', '.kube']
export const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pgpass|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx))$/i
export const SECRET_GLOB = /(^|[/*{,])(\.env|\.netrc|\.npmrc|\.pgpass|id_[a-z0-9*]|\.ssh|\.aws|\.gnupg|\.claude|\.config\/kage)|\.(pem|key|p12|pfx)\b/i
export function agentToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (sender !== 'agent' || AGENT_OK.has(tool)) return undefined
  return `${tool} is not allowed on an agent's task: it may only read and answer. Say in the thread what it would need, and that a person has to ask for it.`
}

const SLACK_SEND = /^mcp__[^_]*.*slack.*__.*(send|post|schedule|reply|add_message)/i
export function slackSendRefusal(tool: string): string | undefined {
  if (!SLACK_SEND.test(tool) || /draft/i.test(tool)) return undefined
  return `${tool} posts as the owner with no sign of Kage. Use the reply tool for this thread, or message_people to tell someone else.`
}
export const memoryDirs = (home: string, envFile: string, harness: { memory?: string | null; ownerMemory?: string | null } = {}) => ({
  own: harness.memory || `${dirname(envFile)}/memory`,
  owner: harness.ownerMemory || `${home}/.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/memory`,
})
export const senderFile = (dir: string, thread: string) => `${dir}/sender/${thread.replace(/[^A-Za-z0-9.]/g, '_')}`

export const sandboxed = (setting: boolean | 'teammates' | undefined, _ownerThread: boolean) => setting === true
