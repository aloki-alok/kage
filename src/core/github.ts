type GithubMention = { thread: string; headline: string; quoted: string; url: string; by: string; fromOwner: boolean; installation?: number }

type User = { login?: string; type?: string; id?: number }
type Said = { body?: string | null; user?: User; html_url?: string; author_association?: string }
type Item = Said & { number?: number; title?: string }
type Payload = {
  action?: string; repository?: { full_name?: string }; installation?: { id?: number }; sender?: User
  issue?: Item; pull_request?: Item; comment?: Said; review?: Said
}

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const WHERE: Record<string, { action: string; said: (p: Payload) => Said | undefined; item: (p: Payload) => Item | undefined }> = {
  issue_comment: { action: 'created', said: p => p.comment, item: p => p.issue },
  pull_request_review_comment: { action: 'created', said: p => p.comment, item: p => p.pull_request },
  pull_request_review: { action: 'submitted', said: p => p.review, item: p => p.pull_request },
  issues: { action: 'opened', said: p => p.issue, item: p => p.issue },
  pull_request: { action: 'opened', said: p => p.pull_request, item: p => p.pull_request },
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function githubMention(type: string, raw: unknown, who: { slug: string; ownerId: number }): GithubMention | undefined {
  const p = (raw ?? {}) as Payload, where = WHERE[type], repo = p.repository?.full_name
  if (!where || p.action !== where.action || !repo || !who.slug) return undefined
  const said = where.said(p), item = where.item(p), by = said?.user?.login ?? '', author = said?.user?.id
  if (!said || !item || author === undefined || p.sender?.id !== author || said.user?.type === 'Bot' || !TRUSTED.has(said.author_association ?? '')) return undefined
  const body = (said.body ?? '').trim()
  if (!new RegExp(`(^|[^\\w-])@${escape(who.slug)}(?![\\w-])`, 'i').test(body)) return undefined
  const thread = `${repo}#${item.number}`
  return {
    thread, headline: `${by} tagged @${who.slug} on ${thread} ${item.title ?? ''}`.trim(), quoted: body,
    url: said.html_url ?? item.html_url ?? '', by, fromOwner: author === who.ownerId,
    ...(p.installation?.id !== undefined && { installation: p.installation.id }),
  }
}

export function installedOn(installations: { id: number; account?: { login?: string } }[], accounts: string[]): Set<number> {
  const allowed = new Set(accounts.map(a => a.toLowerCase()))
  return new Set(installations.filter(i => allowed.has(i.account?.login?.toLowerCase() ?? '')).map(i => i.id))
}

export function githubOwner(o: { login?: string; userId?: number; me?: { login: string; id: number }; needId: boolean }): { login: string; userId?: number } | { error: string } {
  const login = o.login ?? o.me?.login
  if (!login) return { error: 'Run gh auth login, or kage config set connectors.github.login <your GitHub username>, then run kage connector on github again.' }
  const userId = o.userId ?? (o.me?.login.toLowerCase() === login.toLowerCase() ? o.me.id : undefined)
  if (o.needId && userId === undefined) return { error: `Run gh auth login as ${login}, so Kage can save your GitHub user id, then run kage connector on github again.` }
  return { login, ...(userId !== undefined && { userId }) }
}

export function appName(typed: string): { name: string } | { problem: string } {
  const name = typed.trim().replace(/^@/, '').toLowerCase()
  if (!name) return { problem: 'Type the name people will tag.' }
  if (name.length > 34) return { problem: 'GitHub allows at most 34 characters.' }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return { problem: 'Use letters, digits and single hyphens inside the name.' }
  return { name }
}

export const appManifest = (o: { name: string; hook: string; back: string }) => ({
  name: o.name, url: 'https://github.com/aloki-alok/kage', public: true,
  hook_attributes: { url: o.hook, active: true },
  redirect_url: o.back,
  default_permissions: { issues: 'write', pull_requests: 'write', contents: 'read', metadata: 'read' },
  default_events: Object.keys(WHERE).sort(),
})
