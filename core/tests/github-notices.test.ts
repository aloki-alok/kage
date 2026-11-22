import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { githubEvent } from '../github.ts'
import { noticeFeeds } from '../github-notices.ts'

const API = 'https://api.github.com/repos/acme/app'
const me = 'ryu-dev', SINCE = Date.parse('2026-11-22T08:00:00Z')
const AFTER = '2026-11-22T08:05:00Z', BEFORE = '2026-11-21T08:00:00Z'
const notice = (reason: string, subject: Record<string, unknown>, id = '1') => ({ id, reason, updated_at: AFTER, repository: { full_name: 'acme/app' }, subject: { title: 'Faster calls', url: `${API}/issues/7`, latest_comment_url: null, type: 'Issue', ...subject } })
const issue = (o: Record<string, unknown> = {}) => ({ number: 7, title: 'Faster calls', html_url: 'https://github.com/acme/app/issues/7', body: 'plain', user: { login: 'kim' }, author_association: 'MEMBER', created_at: BEFORE, ...o })
const pr = (o: Record<string, unknown> = {}) => issue({ number: 12, html_url: 'https://github.com/acme/app/pull/12', user: { login: me }, ...o })
const comment = (o: Record<string, unknown> = {}) => ({ id: 55, body: `@${me} can you look?`, user: { login: 'kim' }, html_url: 'https://github.com/acme/app/issues/7#issuecomment-55', author_association: 'MEMBER', created_at: AFTER, ...o })

function api(pages: Record<string, unknown>) {
  const asked: string[] = []
  return { asked, get: async (url: string) => { asked.push(url); if (!(url in pages)) throw new Error(`unexpected ${url}`); return pages[url] } }
}
const events = async (n: ReturnType<typeof notice>, pages: Record<string, unknown>) => {
  const a = api(pages)
  const feeds = await noticeFeeds(n, a.get, me, SINCE)
  return { asked: a.asked, sources: feeds.map(f => f.source), lines: feeds.map(f => githubEvent(f.type, f.payload, me)).filter(e => e !== undefined).map(e => `${e.thread} | ${e.headline}`) }
}

describe('a GitHub notification read by polling becomes the same event a webhook would bring', () => {
  test('a member who mentions you in a comment opens the thread; a stranger, an old comment or a comment without your name does not', async () => {
    const n = notice('mention', { latest_comment_url: `${API}/issues/comments/55` })
    const page = (c: Record<string, unknown>) => ({ [`${API}/issues/7`]: issue(), [`${API}/issues/comments/55`]: comment(c) })
    const fresh = await events(n, page({}))
    assert.deepEqual(fresh.lines, ['acme/app#7 | kim mentioned you on acme/app#7 Faster calls'])
    assert.deepEqual(fresh.sources, ['github:c:55'])
    assert.deepEqual((await events(n, page({ author_association: 'NONE' }))).lines, [])
    assert.deepEqual((await events(n, page({ created_at: BEFORE }))).lines, [])
    assert.deepEqual((await events(notice('comment', { latest_comment_url: `${API}/issues/comments/55` }), page({ body: 'looks good' }))).lines, [])
  })

  test('a member who opens an issue that mentions you opens the thread once', async () => {
    const n = notice('mention', { latest_comment_url: `${API}/issues/7` })
    const r = await events(n, { [`${API}/issues/7`]: issue({ body: `@${me} this one is yours`, created_at: AFTER }) })
    assert.deepEqual(r.lines, ['acme/app#7 | kim mentioned you on acme/app#7 Faster calls'])
    assert.deepEqual(r.sources, ['github:b:1'])
  })

  test('a review request or an assignment opens the thread once per notification', async () => {
    const asked = await events(notice('review_requested', { type: 'PullRequest', url: `${API}/pulls/12` }), { [`${API}/pulls/12`]: pr({ user: { login: 'kim' } }) })
    assert.deepEqual(asked.lines, ['acme/app#12 | someone asked you to review acme/app#12 Faster calls'])
    assert.deepEqual(asked.sources, ['github:n:1:review_requested'])
    const assigned = await events(notice('assign', {}), { [`${API}/issues/7`]: issue() })
    assert.deepEqual(assigned.lines, ['acme/app#7 | someone assigned you acme/app#7 Faster calls'])
    assert.deepEqual(assigned.sources, ['github:n:1:assign'])
  })

  test('a new review by a member on your pull request opens the thread; your own review or an old one does not', async () => {
    const n = notice('author', { type: 'PullRequest', url: `${API}/pulls/12` })
    const review = (o: Record<string, unknown>) => ({ id: 9, state: 'CHANGES_REQUESTED', body: 'add a test', user: { login: 'kim' }, html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-9', author_association: 'MEMBER', submitted_at: AFTER, ...o })
    const page = (...rs: Record<string, unknown>[]) => ({ [`${API}/pulls/12`]: pr(), [`${API}/pulls/12/reviews?per_page=100`]: rs })
    const fresh = await events(n, page(review({ id: 8, submitted_at: BEFORE }), review({})))
    assert.deepEqual(fresh.lines, ['acme/app#12 | kim requested changes on acme/app#12 Faster calls'])
    assert.deepEqual(fresh.sources, ['github:r:9'])
    assert.deepEqual((await events(n, page(review({ user: { login: me } })))).lines, [])
    assert.deepEqual((await events(n, page(review({ submitted_at: BEFORE })))).lines, [])
  })

  test('a failed workflow run on a branch with an open pull request opens that pull request\'s thread', async () => {
    const n = notice('ci_activity', { type: 'CheckSuite', url: null, title: 'ci workflow run, Attempt #2 failed for feat/x branch' })
    const open = `${API}/pulls?head=acme%3Afeat%2Fx&state=open`
    assert.deepEqual((await events(n, { [open]: [pr({ number: 5 })] })).lines, ['acme/app#5 | ci: checks failed on acme/app#5 (feat/x)'])
    assert.deepEqual((await events(n, { [open]: [] })).lines, [])
    const passed = await events(notice('ci_activity', { type: 'CheckSuite', url: null, title: 'ci workflow run succeeded for feat/x branch' }), {})
    assert.deepEqual([passed.lines, passed.asked], [[], []])
  })

  test('a notification Kage does not act on costs no request', async () => {
    for (const reason of ['state_change', 'subscribed', 'security_alert']) assert.deepEqual((await events(notice(reason, { latest_comment_url: `${API}/issues/comments/55` }), {})).asked, [])
  })
})
