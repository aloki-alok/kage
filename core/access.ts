// The access tiers (from branch kage-access-tiers): an action's verb comes from code, never from a model.
//   read: looks only. write: sends, or changes something internal. act: prod, money, customers, access, deletes.
// Kagelets are Kage's teammates, so Kage approves for them by tier (runtime/kagelets.ts): it grants read at save
// with no card, a write takes the owner's first yes for that tool, which then stands for every kagelet, and act is
// never a kagelet's. Pure lookups: no model call decides a tier.
export type Verb = 'read' | 'write' | 'act'

// The grant name for the database tool (runtime/kage-tools.ts): a read through the install's own read command.
export const DB_READ = 'db_read'
const READ_TOOLS = ['WebSearch', 'WebFetch', DB_READ]

// An MCP tool is read when its name starts with one of these and names nothing below.
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'describe', 'lookup', 'view', 'show', 'count'])
const WRITE_WORDS = new Set(['send', 'create', 'update', 'write', 'post', 'set', 'add', 'edit', 'put', 'patch', 'upload', 'reply', 'comment', 'move',
  'rename', 'save', 'submit', 'schedule', 'mark', 'start', 'stop', 'import', 'sync', 'publish', 'append', 'insert', 'modify', 'change', 'toggle',
  'enable', 'disable', 'assign', 'approve', 'close', 'open', 'restore', 'reset', 'label', 'tag', 'draft', 'replace', 'upsert', 'or', 'and'])
// Any of these makes it act, whatever its verb.
const ACT_WORDS = new Set(['delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'wipe', 'truncate', 'pay', 'payment', 'payments', 'refund',
  'charge', 'transfer', 'payout', 'invoice', 'billing', 'deploy', 'merge', 'release', 'rollback', 'migrate', 'migration', 'execute', 'exec', 'run',
  'sql', 'shell', 'command', 'invite', 'grant', 'revoke', 'permission', 'permissions', 'role', 'roles', 'share', 'ban', 'kick', 'cancel',
  'terminate', 'kill', 'customer', 'customers', 'prod', 'production', 'secret', 'secrets', 'token', 'tokens', 'key', 'keys', 'password'])

// ponytail: an MCP tool's tier reads its name, so a server that names a write tool get_x passes as read.
// Upgrade path: the server's readOnlyHint from the SDK's mcpServerStatus(), checked beside the name.
export function kageletTier(tool: string): Verb {
  if (READ_TOOLS.includes(tool)) return 'read'
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  // Kage's own tools act as the owner; every other built-in (shell, files, agents) could rewrite a grant.
  if (!m || tool.startsWith('mcp__kage__') || tool.startsWith('mcp__plugin_kage_')) return 'act'
  const words = m[2]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-]+/).filter(Boolean)
  if (words.some(w => ACT_WORDS.has(w))) return 'act'
  return READ_VERBS.has(words[0]!) && !words.some(w => WRITE_WORDS.has(w)) ? 'read' : 'write'
}
