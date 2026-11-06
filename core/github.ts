// GitHub events that are the owner's business: a review on their pull request, failed checks on it,
// an issue or a review request given to them, a comment that mentions them. Everything else is
// dropped here, so Kage spends no turn on it. The text people wrote stays data (`quoted`).
import { createHmac, timingSafeEqual } from 'node:crypto'

// GitHub signs each delivery with the webhook's secret (X-Hub-Signature-256). No secret, no pass.
export function signedByGithub(secret: string, body: string, header: string | undefined): boolean {
  if (!secret || !header) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}

export type GithubEvent = { thread: string; headline: string; quoted: string; url: string }

type User = { login?: string }
type Item = { number?: number; title?: string; html_url?: string; body?: string | null; user?: User }
type Payload = {
  action?: string; repository?: { full_name?: string }; sender?: User
  pull_request?: Item; issue?: Item; review?: { state?: string; body?: string | null; user?: User; html_url?: string; author_association?: string }
  comment?: { body?: string; user?: User; html_url?: string; author_association?: string }; assignee?: User; requested_reviewer?: User
  check_suite?: { conclusion?: string | null; head_branch?: string; pull_requests?: { number?: number }[]; app?: { name?: string } }
}

// On a public repo anyone may comment or review. Only people the repo knows reach the owner's DM.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const REVIEW: Record<string, string> = { approved: 'approved', changes_requested: 'requested changes on', commented: 'reviewed' }

export function githubEvent(type: string, raw: unknown, me: string): GithubEvent | undefined {
  const p = (raw ?? {}) as Payload
  const repo = p.repository?.full_name
  if (!repo || !me) return undefined
  const ref = (n?: number) => `${repo}#${n}`
  const by = (u?: User) => u?.login ?? 'someone'
  const mine = (u?: User) => u?.login?.toLowerCase() === me.toLowerCase()
  const said = (t?: string | null) => (t ?? '').trim()

  if (type === 'pull_request_review' && p.action === 'submitted' && mine(p.pull_request?.user) && !mine(p.review?.user) && TRUSTED.has(p.review?.author_association ?? '')) {
    const pr = p.pull_request!
    return { thread: ref(pr.number), headline: `${by(p.review?.user)} ${REVIEW[p.review?.state ?? ''] ?? 'reviewed'} ${ref(pr.number)} ${pr.title ?? ''}`.trim(), quoted: said(p.review?.body), url: p.review?.html_url ?? pr.html_url ?? '' }
  }
  // A check suite names no pull request author, so "mine" means the owner pushed the commit it ran on.
  // ponytail: misses a teammate's push to the owner's branch and fork PRs (no pull_requests); read the PR author via the API if that bites.
  if (type === 'check_suite' && p.action === 'completed' && (p.check_suite?.conclusion === 'failure' || p.check_suite?.conclusion === 'timed_out') && mine(p.sender)) {
    const n = p.check_suite.pull_requests?.[0]?.number
    if (n === undefined) return undefined
    return { thread: ref(n), headline: `${p.check_suite.app?.name ?? 'checks'}: checks failed on ${ref(n)} (${p.check_suite.head_branch ?? '?'})`, quoted: '', url: `https://github.com/${repo}/pull/${n}/checks` }
  }
  if (type === 'issues' && p.action === 'assigned' && mine(p.assignee)) {
    const i = p.issue!
    return { thread: ref(i.number), headline: `${by(p.sender)} assigned you ${ref(i.number)} ${i.title ?? ''}`.trim(), quoted: said(i.body), url: i.html_url ?? '' }
  }
  if (type === 'pull_request' && p.action === 'review_requested' && mine(p.requested_reviewer)) {
    const pr = p.pull_request!
    return { thread: ref(pr.number), headline: `${by(p.sender)} asked you to review ${ref(pr.number)} ${pr.title ?? ''}`.trim(), quoted: said(pr.body), url: pr.html_url ?? '' }
  }
  if (type === 'issue_comment' && p.action === 'created' && !mine(p.comment?.user) && TRUSTED.has(p.comment?.author_association ?? '')) {
    const body = said(p.comment?.body)
    // @me followed by a non-name character, so @me-bot or @mere do not count.
    if (!new RegExp(`(^|[^\\w-])@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(body)) return undefined
    const i = p.issue!
    return { thread: ref(i.number), headline: `${by(p.comment?.user)} mentioned you on ${ref(i.number)} ${i.title ?? ''}`.trim(), quoted: body, url: p.comment?.html_url ?? i.html_url ?? '' }
  }
  return undefined
}
