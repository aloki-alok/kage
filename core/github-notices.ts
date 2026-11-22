type User = { login?: string }
type Item = { id?: number; number?: number; title?: string; html_url?: string; body?: string | null; user?: User; author_association?: string; created_at?: string; requested_reviewers?: User[]; assignees?: User[] }
type Review = { id?: number; state?: string; body?: string | null; user?: User; html_url?: string; author_association?: string; submitted_at?: string }
type Notice = { id: string; reason: string; updated_at: string; repository: { full_name: string }; subject: { type: string; title: string; url: string | null } }
type Feed = { type: string; payload: object; source: string }

const ACTS_ON = new Set(['mention', 'team_mention', 'comment', 'author', 'review_requested', 'assign', 'ci_activity'])
const CI_FAILED = /^(.+?) workflow run(?:, Attempt #\d+)? failed for (.+) branch$/

export function notices(raw: unknown): Notice[] {
  if (!Array.isArray(raw)) return []
  const newest = new Map<string, Notice>()
  for (const n of raw.filter((n): n is Notice => typeof n?.id === 'string' && typeof n?.reason === 'string' && typeof n?.updated_at === 'string'
    && typeof n?.repository?.full_name === 'string' && typeof n?.subject?.title === 'string')) if (!(newest.get(n.id)?.updated_at! >= n.updated_at)) newest.set(n.id, n)
  return [...newest.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at))
}

export async function noticeFeeds(n: Notice, get: (url: string) => Promise<unknown>, me: string, since: number): Promise<Feed[]> {
  if (!ACTS_ON.has(n.reason)) return []
  const full = n.repository.full_name, repository = { full_name: full }, s = n.subject
  const fresh = (at?: string) => Date.parse(at ?? '') >= since
  if (n.reason === 'ci_activity') {
    const m = CI_FAILED.exec(s.title)
    if (!m) return []
    const head = encodeURIComponent(`${repository.full_name.split('/')[0]}:${m[2]}`)
    const [pr] = (await get(`https://api.github.com/repos/${repository.full_name}/pulls?head=${head}&state=open`) ?? []) as Item[]
    if (pr?.number === undefined) return []
    return [{ type: 'check_suite', source: `github:n:${n.id}:${n.updated_at}`,
      payload: { action: 'completed', repository, sender: { login: me }, check_suite: { conclusion: 'failure', head_branch: m[2], pull_requests: [{ number: pr.number }], app: { name: m[1] } } } }]
  }
  if (!s.url) return []
  const mine = (u?: User) => u?.login?.toLowerCase() === me.toLowerCase()
  const isPr = s.type === 'PullRequest', after = `since=${new Date(since).toISOString()}&per_page=100`
  const list = async <T>(url: string) => (await get(url) ?? []) as T[]
  const item = await get(s.url) as Item
  const comments = await list<Item>(`${s.url.replace('/pulls/', '/issues/')}/comments?${after}`)
  const inline = isPr ? await list<Item>(`${s.url}/comments?${after}`) : []
  const reviews = isPr ? await list<Review>(`${s.url}/reviews?per_page=100`) : []
  const said = (comment: object, source: string): Feed => ({ type: 'issue_comment', source, payload: { action: 'created', repository, issue: item, comment } })
  const theirs = reviews.filter(r => !mine(r.user) && fresh(r.submitted_at))
  const feeds = [
    ...n.reason === 'mention' && fresh(item.created_at) ? [said(item, `github:b:${n.id}`)] : [],
    ...comments.filter(c => fresh(c.created_at)).map(c => said(c, `github:c:${c.id}`)),
    ...inline.filter(c => fresh(c.created_at)).map(c => said(c, `github:pc:${c.id}`)),
    ...mine(item.user) ? theirs.map((r): Feed => ({ type: 'pull_request_review', source: `github:r:${r.id}`, payload: { action: 'submitted', repository, pull_request: item, review: { ...r, state: r.state?.toLowerCase() } } }))
      : theirs.map(r => said(r, `github:rm:${r.id}`)),
  ]
  if (n.reason === 'review_requested' && (item.requested_reviewers ?? []).some(mine)) feeds.push({ type: 'pull_request', source: `github:rr:${full}#${item.number}:${reviews.filter(r => mine(r.user)).length}`, payload: { action: 'review_requested', repository, pull_request: item, requested_reviewer: { login: me } } })
  if (n.reason === 'assign' && (item.assignees ?? []).some(mine)) feeds.push({ type: 'issues', source: `github:as:${full}#${item.number}`, payload: { action: 'assigned', repository, issue: item, assignee: { login: me } } })
  return feeds
}
