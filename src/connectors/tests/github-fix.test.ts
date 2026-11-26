import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixer } from '../github-fix.ts'
import type { FixMode } from '../../core/github-fix.ts'

const base = { repository: { full_name: 'acme/app' }, installation: { id: 41 } }
const failed = (sha = 'abc1234def', prs = [{ number: 7 }]) => ({ ...base, action: 'completed', check_suite: { conclusion: 'failure', head_sha: sha, app: { slug: 'ci' }, pull_requests: prs } })
const closed = { ...base, action: 'closed', pull_request: { number: 7 } }
type Runs = Record<string, 'success' | 'failure' | null>

function setup(mode: FixMode = 'on', o: { perPr?: number; head?: () => string; author?: number; saved?: Record<string, unknown>; allowed?: () => boolean; required?: string[]; headRuns?: Runs; baseRuns?: Runs } = {}) {
  const calls: string[] = [], comments: { path: string; body: unknown }[] = []
  let saved = (o.saved ?? {}) as never
  const runs = (r: Runs) => ({ check_runs: Object.entries(r).map(([name, conclusion], id) => ({ id, name, status: conclusion ? 'completed' : 'in_progress', conclusion })) })
  const f = fixer({
    mode, perPr: o.perPr ?? 3, ownerId: 1, ownerLogin: 'alok', slug: 'kage-me', allowed: id => id === 41 && (o.allowed?.() ?? true),
    seen: { load: () => saved, save: s => { saved = JSON.parse(JSON.stringify(s)) as never } },
    call: () => async (method, path, body) => {
      if (method === 'POST') { comments.push({ path, body }); return {} }
      calls.push(path.replace(/[?&]per_page=100&page=1$/, ''))
      if (path.endsWith('/pulls')) return [{ number: 7 }]
      if (path.startsWith('/repos/acme/app/branches/main')) return { protected: true, protection: { required_status_checks: { contexts: o.required ?? ['pr-check'] } } }
      if (path.startsWith('/repos/acme/app/rules/')) return []
      if (path.endsWith('/status')) return { statuses: [] }
      if (path.startsWith('/repos/acme/app/commits/main/check-runs')) return runs(o.baseRuns ?? { 'pr-check': 'success' })
      if (path.includes('/check-runs')) return runs(o.headRuns ?? { 'pr-check': 'failure', 'peer-review': 'failure' })
      return { number: 7, title: 'Faster calls', html_url: 'https://gh/acme/app/pull/7', state: 'open', draft: false, user: { id: o.author ?? 1 }, labels: [], head: { sha: o.head?.() ?? 'abc1234def', ref: 'fix/a', repo: { full_name: 'acme/app' } }, base: { ref: 'main', repo: { full_name: 'acme/app' } } }
    },
  })
  return { f, calls, comments, saved: () => saved as Record<string, unknown> }
}

test('a failed required check on the owner\'s pull request starts one live fix at once, and the same commit starts no second', async () => {
  const { f, saved } = setup()
  const first = await f.handle('check_suite', failed())
  assert.equal(first.length, 1)
  first[0]!.began()
  assert.deepEqual([first[0]!.live, first[0]!.thread, first[0]!.headline], [true, 'acme/app#7', 'Checks failed on acme/app#7 Faster calls'])
  assert.match(first[0]!.content, /The required checks pr-check failed\./)
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(saved(), { 'acme/app#7': { keys: ['abc1234def:red checks'], tries: 1 } })
})

test('a failed check the base branch does not require, such as a wait for a peer review, starts nothing', async () => {
  const { f, saved } = setup('on', { headRuns: { 'pr-check': 'success', 'peer-review': 'failure' } })
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(saved(), {})
})

test('a required check that fails on the base branch too starts nothing, and one that fails only on the pull request starts a fix', async () => {
  assert.deepEqual(await setup('on', { baseRuns: { 'pr-check': 'failure' } }).f.handle('check_suite', failed()), [])
  assert.equal((await setup('on', { baseRuns: { 'pr-check': null } }).f.handle('check_suite', failed())).length, 1)
})

test('a base branch that requires no checks starts no fix for red checks', async () => {
  assert.deepEqual(await setup('on', { required: [] }).f.handle('check_suite', failed()), [])
})

test('shadow mode names the fix it would start, marks it not live, and saves nothing', async () => {
  const { f, saved } = setup('shadow')
  const starts = await f.handle('check_suite', failed())
  assert.deepEqual(starts.map(s => s.live), [false])
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(saved(), {})
})

test('a suite that names no pull request finds them from the commit', async () => {
  const { f, calls } = setup()
  assert.equal((await f.handle('check_suite', failed('abc1234def', []))).length, 1)
  assert.deepEqual(calls.slice(0, 2), ['/repos/acme/app/commits/abc1234def/pulls', '/repos/acme/app/pulls/7'])
})

test('a pull request someone else opened, or an installation that is not allowed, starts nothing and reads no checks', async () => {
  const theirs = setup('on', { author: 9 })
  assert.deepEqual(await theirs.f.handle('check_suite', failed()), [])
  assert.deepEqual(theirs.calls, ['/repos/acme/app/pulls/7'])
  const other = setup()
  assert.deepEqual(await other.f.handle('check_suite', { ...failed(), installation: { id: 77 } }), [])
  assert.deepEqual(other.calls, [])
})

test('after its fixes are used up the owner is tagged once on the pull request, and closing it clears the count', async () => {
  let head = 'aaa1111'
  const { f, comments } = setup('on', { perPr: 2, head: () => head })
  for (const sha of ['aaa1111', 'bbb2222']) { head = sha; const [start] = await f.handle('check_suite', failed(sha)); start!.began() }
  for (const sha of ['ccc3333', 'ddd4444']) { head = sha; assert.deepEqual(await f.handle('check_suite', failed(sha)), []) }
  assert.equal(comments.length, 1)
  assert.equal(comments[0]!.path, '/repos/acme/app/issues/7/comments')
  assert.match((comments[0]!.body as { body: string }).body, /^@alok Kage tried 2 fixes/)
  await f.handle('pull_request', closed)
  head = 'eee5555'
  assert.equal((await f.handle('check_suite', failed('eee5555'))).length, 1)
})

test('in shadow mode a pull request that used up its fixes gets no comment', async () => {
  let head = 'aaa1111'
  const { f, comments } = setup('shadow', { perPr: 1, head: () => head })
  await f.handle('check_suite', failed('aaa1111'))
  head = 'bbb2222'
  await f.handle('check_suite', failed('bbb2222'))
  assert.deepEqual(comments, [])
})

test('fixes already started are remembered across a restart', async () => {
  const { f } = setup('on', { saved: { 'acme/app#7': { keys: ['abc1234def:red checks'], tries: 1 } } })
  assert.deepEqual(await f.handle('check_suite', failed()), [])
})

test('a live fix that never began is offered again on the next event for that commit, and uses up no try', async () => {
  const { f, saved } = setup()
  assert.equal((await f.handle('check_suite', failed())).length, 1)
  assert.deepEqual(saved(), {})
  const again = await f.handle('check_suite', failed())
  assert.equal(again.length, 1)
  again[0]!.began()
  assert.deepEqual(saved(), { 'acme/app#7': { keys: ['abc1234def:red checks'], tries: 1 } })
})

const asked = { ...base, action: 'submitted', pull_request: { number: 7 }, review: { state: 'changes_requested', commit_id: 'abc1234def', body: 'Rename it', author_association: 'MEMBER', user: { login: 'kim', type: 'User' } } }
test('a listed reviewer asking for changes starts a fix at once that quotes the review, and an outsider starts none', async () => {
  const { f, calls } = setup()
  const [start] = await f.handle('pull_request_review', asked)
  assert.equal(start!.headline, 'kim asked for changes on acme/app#7 Faster calls')
  assert.match(start!.content, /^> Rename it$/m)
  assert.deepEqual(calls, ['/repos/acme/app/pulls/7'])
  assert.deepEqual(await setup().f.handle('pull_request_review', { ...asked, review: { ...asked.review, author_association: 'NONE' } }), [])
})
