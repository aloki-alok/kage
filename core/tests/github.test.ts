import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { appManifest, githubMention, installedOn } from '../github.ts'
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
const who = { slug: 'kage-ryu', owner: 'ryu-dev' }
const installation = { id: 41 }
const issue = { number: 7, title: 'Calls drop', html_url: 'https://gh/7' }
const comment = (body: string, login: string, author_association = 'MEMBER', type = 'User') =>
  githubMention('issue_comment', { action: 'created', repository: repo, installation, issue, comment: { body, user: { login, type }, html_url: 'https://gh/c', author_association } }, who)

describe('only a tag of the app wakes Kage', () => {
  test('a member who tags the app starts one task in that thread, as someone other than the owner', () => {
    assert.deepEqual(comment('@kage-ryu why do calls drop?', 'kim'), {
      thread: 'acme/app#7', headline: 'kim tagged @kage-ryu on acme/app#7 Calls drop', quoted: '@kage-ryu why do calls drop?',
      url: 'https://gh/c', by: 'kim', fromOwner: false, installation: 41,
    })
  })

  test('the owner who tags the app is the owner', () => {
    assert.equal(comment('@kage-ryu ship it', 'Ryu-Dev', 'OWNER')?.fromOwner, true)
  })

  test('no tag, a tag of a longer name, the owner\'s own name, a stranger, a bot, or an edit wakes nothing', () => {
    assert.equal(comment('no tag here', 'kim'), undefined)
    assert.equal(comment('@kage-ryu-old hi', 'kim'), undefined)
    assert.equal(comment('@ryu-dev can you look?', 'kim'), undefined)
    assert.equal(comment('@kage-ryu run this', 'stranger', 'NONE'), undefined)
    assert.equal(comment('@kage-ryu hi', 'fan', 'CONTRIBUTOR'), undefined)
    assert.equal(comment('@kage-ryu done', 'kage-ryu[bot]', 'NONE', 'Bot'), undefined)
    assert.equal(comment('@kage-ryu hi', 'other-ci', 'MEMBER', 'Bot'), undefined)
    assert.equal(githubMention('issue_comment', { action: 'edited', repository: repo, installation, issue, comment: { body: '@kage-ryu hi', user: { login: 'kim' }, author_association: 'MEMBER' } }, who), undefined)
  })

  test('a tag in an inline review comment, a review, a new issue or a new pull request wakes it too', () => {
    const pr = { number: 9, title: 'Faster calls', html_url: 'https://gh/9', body: '', user: { login: 'kim' }, author_association: 'MEMBER' }
    const inline = githubMention('pull_request_review_comment', { action: 'created', repository: repo, installation, pull_request: pr, comment: { body: '@kage-ryu is this safe?', user: { login: 'kim' }, html_url: 'https://gh/r', author_association: 'MEMBER' } }, who)
    const review = githubMention('pull_request_review', { action: 'submitted', repository: repo, installation, pull_request: pr, review: { body: '@kage-ryu check the tests', user: { login: 'kim' }, html_url: 'https://gh/v', author_association: 'COLLABORATOR' } }, who)
    const opened = githubMention('issues', { action: 'opened', repository: repo, installation, issue: { ...issue, body: 'Calls drop. @kage-ryu look', user: { login: 'kim' }, author_association: 'MEMBER' } }, who)
    const prOpened = githubMention('pull_request', { action: 'opened', repository: repo, installation, pull_request: { ...pr, body: '@kage-ryu review please' } }, who)
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
