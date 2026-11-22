type User = { login?: string }
type Item = { number?: number; title?: string; html_url?: string; body?: string | null; user?: User; author_association?: string; created_at?: string }
type Review = { id?: number; state?: string; body?: string | null; user?: User; html_url?: string; author_association?: string; submitted_at?: string }
type Notice = { id: string; reason: string; updated_at: string; repository: { full_name: string }; subject: { type: string; title: string; url: string | null; latest_comment_url: string | null } }
type Feed = { type: string; payload: object; source: string }

const ACTS_ON = new Set(['mention', 'team_mention', 'comment', 'author', 'review_requested', 'assign', 'ci_activity'])
const COMMENT_URL = /\/(issues|pulls)\/comments\/(\d+)$/
const CI_FAILED = /^(.+?) workflow run(?:, Attempt #\d+)? failed for (.+) branch$/

export function notices(raw: unknown): Notice[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is Notice => typeof n?.id === 'string' && typeof n?.reason === 'string' && typeof n?.updated_at === 'string'
    && typeof n?.repository?.full_name === 'string' && typeof n?.subject?.title === 'string')
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
}

export async function noticeFeeds(n: Notice, get: (url: string) => Promise<unknown>, me: string, since: number): Promise<Feed[]> {
  if (!ACTS_ON.has(n.reason)) return []
  const repository = { full_name: n.repository.full_name }, s = n.subject
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
  const item = await get(s.url) as Item, feeds: Feed[] = []
  const said = s.latest_comment_url && COMMENT_URL.exec(s.latest_comment_url)
  if (said) {
    const comment = await get(s.latest_comment_url!) as Item
    if (fresh(comment.created_at)) feeds.push({ type: 'issue_comment', source: `github:c:${said[2]}`, payload: { action: 'created', repository, issue: item, comment } })
  } else if (n.reason === 'mention' && s.latest_comment_url === s.url && fresh(item.created_at)) {
    feeds.push({ type: 'issue_comment', source: `github:b:${n.id}`, payload: { action: 'created', repository, issue: item, comment: item } })
  }
  if (n.reason === 'review_requested') feeds.push({ type: 'pull_request', source: `github:n:${n.id}:review_requested`, payload: { action: 'review_requested', repository, pull_request: item, requested_reviewer: { login: me } } })
  if (n.reason === 'assign') feeds.push({ type: 'issues', source: `github:n:${n.id}:assign`, payload: { action: 'assigned', repository, issue: item, assignee: { login: me } } })
  if (n.reason === 'author' && s.type === 'PullRequest') {
    const review = ((await get(`${s.url}/reviews?per_page=100`) ?? []) as Review[]).filter(r => r.user?.login?.toLowerCase() !== me.toLowerCase() && fresh(r.submitted_at)).at(-1)
    if (review) feeds.push({ type: 'pull_request_review', source: `github:r:${review.id}`, payload: { action: 'submitted', repository, pull_request: item, review: { ...review, state: review.state?.toLowerCase() } } })
  }
  return feeds
}
