type Verb = 'read' | 'write' | 'act'

export const DB_READ = 'db_read'
const READ_TOOLS = ['WebSearch', 'WebFetch', DB_READ]

const ACT_WORDS = new Set(['delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'wipe', 'truncate', 'pay', 'payment', 'payments', 'refund',
  'charge', 'transfer', 'payout', 'invoice', 'billing', 'deploy', 'merge', 'release', 'rollback', 'migrate', 'migration', 'execute', 'exec', 'run',
  'sql', 'shell', 'command', 'invite', 'grant', 'revoke', 'permission', 'permissions', 'role', 'roles', 'share', 'ban', 'kick', 'cancel',
  'terminate', 'kill', 'customer', 'customers', 'prod', 'production', 'secret', 'secrets', 'token', 'tokens', 'key', 'keys', 'password'])

export const ALL = 'all'

export function kageletTier(tool: string): Verb {
  if (READ_TOOLS.includes(tool)) return 'read'
  if (tool === ALL) return 'write'
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m || tool.startsWith('mcp__kage__') || tool.startsWith('mcp__plugin_kage_')) return 'act'
  const words = m[2]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-]+/).filter(Boolean)
  return words.some(w => ACT_WORDS.has(w)) ? 'act' : 'write'
}
