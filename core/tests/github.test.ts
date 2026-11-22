import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { appManifest, githubMention, githubOwner, installedOn } from '../github.ts'
import { signedSha256 } from '../signature.ts'

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
describe('a webhook signature (GitHub, Meta)', () => {
  test('only a body signed with the shared secret passes', () => {
    const body = '{"a":1}'
    assert.equal(signedSha256('s3cret', body, sign('s3cret', body)), true)
    assert.equal(signedSha256('s3cret', body, sign('other', body)), false)
    assert.equal(signedSha256('s3cret', body + ' ', sign('s3cret', body)), false)
    assert.equal(signedSha256('s3cret', body, undefined), false)
    assert.equal(signedSha256('', body, sign('', body)), false)
  })
})

const repo = { full_name: 'acme/app' }
const who = { slug: 'kage-ryu', ownerId: 9 }
const installation = { id: 41 }
const issue = { number: 7, title: 'Calls drop', html_url: 'https://gh/7' }
const ids: Record<string, number> = { kim: 5, 'Ryu-Dev': 9, 'ryu-dev': 9 }
const user = (login: string, type = 'User') => ({ login, type, id: ids[login] ?? 70 })
const comment = (body: string, login: string, author_association = 'MEMBER', type = 'User') =>
  githubMention('issue_comment', { action: 'created', repository: repo, installation, sender: user(login, type), issue, comment: { body, user: user(login, type), html_url: 'https://gh/c', author_association } }, who)

describe('only a tag of the app wakes Kage', () => {
  test('a member who tags the app starts one task in that thread, as someone other than the owner', () => {
    assert.deepEqual(comment('@kage-ryu why do calls drop?', 'kim'), {
      thread: 'acme/app#7', headline: 'kim tagged @kage-ryu on acme/app#7 Calls drop', quoted: '@kage-ryu why do calls drop?',
      url: 'https://gh/c', by: 'kim', fromOwner: false, installation: 41,
    })
  })

  test('the owner is known by their GitHub user id, so a new account that takes their old name, or a name like theirs, is not the owner', () => {
    assert.equal(comment('@kage-ryu ship it', 'Ryu-Dev', 'OWNER')?.fromOwner, true)
    const by = (login: string, id: number) => githubMention('issue_comment', { action: 'created', repository: repo, installation, sender: { login, id }, issue, comment: { body: '@kage-ryu ship it', user: { login, id }, author_association: 'OWNER' } }, who)
    assert.equal(by('ryu-dev', 666)?.fromOwner, false)
    assert.equal(by('ryu-dev2', 10)?.fromOwner, false)
  })

  test('a tag is heard only from the person who acted now, so an issue the owner wrote and someone else moved in wakes nothing', () => {
    const moved = { ...issue, body: '@kage-ryu deploy it', user: { login: 'ryu-dev', id: 9 }, author_association: 'OWNER' }
    assert.equal(githubMention('issues', { action: 'opened', repository: repo, installation, sender: { login: 'kim', id: 5 }, issue: moved }, who), undefined)
    assert.equal(githubMention('issues', { action: 'opened', repository: repo, installation, issue: moved }, who), undefined)
    assert.equal(githubMention('issues', { action: 'opened', repository: repo, installation, sender: { login: 'ryu-dev', id: 9 }, issue: moved }, who)?.fromOwner, true)
  })

  test('no tag, a tag of a longer name, the owner\'s own name, a stranger, a bot, or an edit wakes nothing', () => {
    assert.equal(comment('no tag here', 'kim'), undefined)
    assert.equal(comment('@kage-ryu-old hi', 'kim'), undefined)
    assert.equal(comment('mail x@kage-ryu hi', 'kim'), undefined)
    assert.equal(comment('@ryu-dev can you look?', 'kim'), undefined)
    assert.equal(comment('@kage-ryu run this', 'stranger', 'NONE'), undefined)
    assert.equal(comment('@kage-ryu hi', 'fan', 'CONTRIBUTOR'), undefined)
    assert.equal(comment('@kage-ryu done', 'kage-ryu[bot]', 'NONE', 'Bot'), undefined)
    assert.equal(comment('@kage-ryu hi', 'other-ci', 'MEMBER', 'Bot'), undefined)
    assert.equal(githubMention('issue_comment', { action: 'edited', repository: repo, installation, sender: user('kim'), issue, comment: { body: '@kage-ryu hi', user: user('kim'), author_association: 'MEMBER' } }, who), undefined)
  })

  test('a tag in an inline review comment, a review, a new issue or a new pull request wakes it too', () => {
    const kim = user('kim'), sender = kim
    const pr = { number: 9, title: 'Faster calls', html_url: 'https://gh/9', body: '', user: kim, author_association: 'MEMBER' }
    const inline = githubMention('pull_request_review_comment', { action: 'created', repository: repo, installation, sender, pull_request: pr, comment: { body: '@kage-ryu is this safe?', user: kim, html_url: 'https://gh/r', author_association: 'MEMBER' } }, who)
    const review = githubMention('pull_request_review', { action: 'submitted', repository: repo, installation, sender, pull_request: pr, review: { body: '@kage-ryu check the tests', user: kim, html_url: 'https://gh/v', author_association: 'COLLABORATOR' } }, who)
    const opened = githubMention('issues', { action: 'opened', repository: repo, installation, sender, issue: { ...issue, body: 'Calls drop. @kage-ryu look', user: kim, author_association: 'MEMBER' } }, who)
    const prOpened = githubMention('pull_request', { action: 'opened', repository: repo, installation, sender, pull_request: { ...pr, body: '@kage-ryu review please' } }, who)
    assert.deepEqual([inline?.thread, review?.thread, opened?.thread, prOpened?.thread], ['acme/app#9', 'acme/app#9', 'acme/app#7', 'acme/app#9'])
    assert.deepEqual([inline?.quoted, review?.quoted, opened?.quoted], ['@kage-ryu is this safe?', '@kage-ryu check the tests', 'Calls drop. @kage-ryu look'])
  })

  test('a review request, an assignment, a review with no tag, a failed check, a push or a ping wakes nothing', () => {
    const pr = { number: 9, title: 'x', html_url: '', user: { login: 'ryu-dev' } }
    assert.equal(githubMention('pull_request', { action: 'review_requested', repository: repo, installation, pull_request: pr, requested_reviewer: { login: 'ryu-dev' } }, who), undefined)
    assert.equal(githubMention('issues', { action: 'assigned', repository: repo, installation, issue, assignee: { login: 'ryu-dev' } }, who), undefined)
    assert.equal(githubMention('pull_request_review', { action: 'submitted', repository: repo, installation, pull_request: pr, review: { body: 'looks good', user: { login: 'kim' }, author_association: 'MEMBER' } }, who), undefined)
    assert.equal(githubMention('check_suite', { action: 'completed', repository: repo, installation, check_suite: { conclusion: 'failure' } }, who), undefined)
    assert.equal(githubMention('push', { repository: repo, installation }, who), undefined)
    assert.equal(githubMention('ping', { zen: 'x' }, who), undefined)
  })
})

describe('Kage acts only on installations on the accounts the owner allows', () => {
  test('the installations on allowed accounts are kept by id, and any other account is dropped, whatever its case', () => {
    const list = [{ id: 41, account: { login: 'Ryu-Dev' } }, { id: 42, account: { login: 'acme' } }, { id: 43, account: { login: 'someone-else' } }, { id: 44 }]
    assert.deepEqual(installedOn(list, ['ryu-dev', 'ACME']), new Set([41, 42]))
    assert.deepEqual(installedOn(list, []), new Set())
  })
})

describe('the app Kage asks GitHub to create', () => {
  test('a public app named for the owner, sending only the events a tag can come in, to the tunnel, and back to Kage when made', () => {
    assert.deepEqual(appManifest({ login: 'Ryu-Dev', hook: 'https://box.tail1.ts.net:8443/github', back: 'http://127.0.0.1:5555/done' }), {
      name: 'Kage ryu-dev', url: 'https://github.com/aloki-alok/kage', public: true,
      hook_attributes: { url: 'https://box.tail1.ts.net:8443/github', active: true },
      redirect_url: 'http://127.0.0.1:5555/done',
      default_permissions: { issues: 'write', pull_requests: 'write', contents: 'read', metadata: 'read' },
      default_events: ['issue_comment', 'issues', 'pull_request', 'pull_request_review', 'pull_request_review_comment'],
    })
  })
})

describe('whose tags run as the owner, chosen at setup', () => {
  const me = { login: 'Ryu-Dev', id: 9 }
  test('the user id comes from the saved setting first, then from the gh login when it is the same person', () => {
    assert.deepEqual(githubOwner({ login: 'ryu-dev', userId: 4, me, needId: true }), { login: 'ryu-dev', userId: 4 })
    assert.deepEqual(githubOwner({ me, needId: true }), { login: 'Ryu-Dev', userId: 9 })
    assert.deepEqual(githubOwner({ login: 'ryu-dev', me, needId: true }), { login: 'ryu-dev', userId: 9 })
  })

  test('a gh login of someone else gives no id, and where the new app cannot supply it (an org app, an app made before) setup stops', () => {
    const other = { login: 'kim', id: 5 }
    assert.deepEqual(githubOwner({ login: 'ryu-dev', me: other, needId: false }), { login: 'ryu-dev' })
    assert.match((githubOwner({ login: 'ryu-dev', me: other, needId: true }) as { error: string }).error, /gh auth login as ryu-dev/)
    assert.match((githubOwner({ needId: false }) as { error: string }).error, /connectors\.github\.login/)
  })
})
