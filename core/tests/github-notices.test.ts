import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { githubEvent } from '../github.ts'
import { noticeFeeds } from '../github-notices.ts'

const API = 'https://api.github.com/repos/acme/app'
const me = 'ryu-dev', SINCE = Date.parse('2026-11-22T08:00:00Z'), AFTER_ISO = '2026-11-22T08:00:00.000Z'
const AFTER = '2026-11-22T08:05:00Z', LATER = '2026-11-22T08:06:00Z', BEFORE = '2026-11-21T08:00:00Z'
const notice = (reason: string, subject: Record<string, unknown> = {}, id = '1') => ({ id, reason, updated_at: AFTER, repository: { full_name: 'acme/app' }, subject: { title: 'Faster calls', url: `${API}/issues/7`, latest_comment_url: null, type: 'Issue', ...subject } })
const onPr = (reason: string) => notice(reason, { type: 'PullRequest', url: `${API}/pulls/12` })
const issue = (o: Record<string, unknown> = {}) => ({ number: 7, title: 'Faster calls', html_url: 'https://github.com/acme/app/issues/7', body: 'plain', user: { login: 'kim' }, author_association: 'MEMBER', created_at: BEFORE, ...o })
const pr = (o: Record<string, unknown> = {}) => issue({ number: 12, html_url: 'https://github.com/acme/app/pull/12', user: { login: me }, ...o })
const comment = (o: Record<string, unknown> = {}) => ({ id: 55, body: `@${me} can you look?`, user: { login: 'kim' }, html_url: 'https://github.com/acme/app/issues/7#issuecomment-55', author_association: 'MEMBER', created_at: AFTER, ...o })
const review = (o: Record<string, unknown> = {}) => ({ id: 9, state: 'CHANGES_REQUESTED', body: 'add a test', user: { login: 'kim' }, html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-9', author_association: 'MEMBER', submitted_at: AFTER, ...o })
const issuePages = (comments: object[], o: Record<string, unknown> = {}) => ({ [`${API}/issues/7`]: issue(o), [`${API}/issues/7/comments?since=${AFTER_ISO}&per_page=100`]: comments })
const prPages = (o: { pr?: Record<string, unknown>; comments?: object[]; inline?: object[]; reviews?: object[] }) => ({
  [`${API}/pulls/12`]: pr(o.pr), [`${API}/issues/12/comments?since=${AFTER_ISO}&per_page=100`]: o.comments ?? [],
  [`${API}/pulls/12/comments?since=${AFTER_ISO}&per_page=100`]: o.inline ?? [], [`${API}/pulls/12/reviews?per_page=100`]: o.reviews ?? [] })

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
    const fresh = await events(notice('mention'), issuePages([comment()]))
    assert.deepEqual(fresh.lines, ['acme/app#7 | kim mentioned you on acme/app#7 Faster calls'])
    assert.deepEqual(fresh.sources, ['github:c:55'])
    assert.deepEqual((await events(notice('mention'), issuePages([comment({ author_association: 'NONE' })]))).lines, [])
    assert.deepEqual((await events(notice('mention'), issuePages([comment({ created_at: BEFORE })]))).lines, [])
    assert.deepEqual((await events(notice('comment'), issuePages([comment({ body: 'looks good' })]))).lines, [])
  })

  test('a mention followed by another comment before the next read still opens the thread', async () => {
    const r = await events(notice('mention'), issuePages([comment(), comment({ id: 56, body: 'thanks all', user: { login: 'lee' }, created_at: LATER })]))
    assert.deepEqual(r.lines, ['acme/app#7 | kim mentioned you on acme/app#7 Faster calls'])
  })

  test('a mention in an inline review comment or a review body opens the thread', async () => {
    const inline = await events(onPr('mention'), prPages({ pr: { user: { login: 'lee' } }, inline: [comment({ id: 70 })] }))
    assert.deepEqual(inline.lines, ['acme/app#12 | kim mentioned you on acme/app#12 Faster calls'])
    const body = await events(onPr('mention'), prPages({ pr: { user: { login: 'lee' } }, reviews: [review({ state: 'COMMENTED', body: `@${me} what do you think?` })] }))
    assert.deepEqual(body.lines, ['acme/app#12 | kim mentioned you on acme/app#12 Faster calls'])
  })

  test('a member who opens an issue that mentions you opens the thread once', async () => {
    const r = await events(notice('mention'), issuePages([], { body: `@${me} this one is yours`, created_at: AFTER }))
    assert.deepEqual(r.lines, ['acme/app#7 | kim mentioned you on acme/app#7 Faster calls'])
    assert.deepEqual(r.sources, ['github:b:1'])
  })

  test('a review request to you opens the thread once per round; a request to your team only, or one already answered, does not', async () => {
    const asked = (o: { pr?: Record<string, unknown>; reviews?: object[] }) => events(onPr('review_requested'), prPages({ pr: { user: { login: 'kim' } }, ...o }))
    const first = await asked({ pr: { requested_reviewers: [{ login: 'Ryu-Dev' }] } })
    assert.deepEqual(first.lines, ['acme/app#12 | someone asked you to review acme/app#12 Faster calls'])
    const again = await asked({ pr: { requested_reviewers: [{ login: me }] }, reviews: [review({ user: { login: me }, submitted_at: BEFORE })] })
    assert.equal(again.lines.length, 1)
    assert.notEqual(again.sources[0], first.sources[0])
    assert.deepEqual((await asked({ pr: { requested_reviewers: [], requested_teams: [{ slug: 'core' }] } })).lines, [])
  })

  test('an assignment opens the thread only while you are assigned', async () => {
    const assigned = await events(notice('assign'), issuePages([], { assignees: [{ login: me }] }))
    assert.deepEqual(assigned.lines, ['acme/app#7 | someone assigned you acme/app#7 Faster calls'])
    assert.deepEqual((await events(notice('assign'), issuePages([], { assignees: [{ login: 'kim' }] }))).lines, [])
  })

  test('every new review by a member on your pull request opens the thread; your own review or an old one does not', async () => {
    const both = await events(onPr('author'), prPages({ reviews: [review({ id: 8, submitted_at: BEFORE }), review(), review({ id: 10, state: 'APPROVED', user: { login: 'lee' }, submitted_at: LATER })] }))
    assert.deepEqual(both.lines, ['acme/app#12 | kim requested changes on acme/app#12 Faster calls', 'acme/app#12 | lee approved acme/app#12 Faster calls'])
    assert.deepEqual((await events(onPr('author'), prPages({ reviews: [review({ user: { login: me } })] }))).lines, [])
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
    for (const reason of ['state_change', 'subscribed', 'security_alert']) assert.deepEqual((await events(notice(reason), {})).asked, [])
  })
})
