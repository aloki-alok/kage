import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approver } from '../github-approve.ts'
import { GithubRefused, type GithubCall } from '../github-app.ts'

type Review = { id: number; state: string; commit_id: string; user: { login: string } }
function fakeGithub(o: { repoPolicy?: string; orgPolicy?: string | null; head?: string; movedTo?: string; statuses?: { context: string; state: string }[]; renamedFrom?: string; files?: string[]; checks?: { id: number; name: string; status: string; conclusion: string | null }[]; reviews?: Review[]; author?: string; required?: string[] } = {}) {
  const writes: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const head = o.head ?? 'bbb2222'
  const pr = { number: 7, state: 'open', draft: false, user: { login: o.author ?? 'ana' }, html_url: 'https://gh/acme/app/pull/7', head: { sha: head, repo: { full_name: 'acme/app' } }, base: { ref: 'main', repo: { full_name: 'acme/app' } } }
  const routes: Record<string, unknown> = {
    '/repos/acme/app/pulls/7': pr,
    '/repos/acme/app/branches/main': { protected: true, protection: { required_status_checks: { contexts: o.required ?? ['build'] } } },
    '/repos/acme/app/pulls/7/files?per_page=100&page=1': (o.files ?? ['docs/a.md']).map(filename => ({ filename, ...(o.renamedFrom && { previous_filename: o.renamedFrom }) })),
    [`/repos/acme/app/commits/${head}/check-runs?per_page=100&page=1`]: { check_runs: o.checks ?? [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
    [`/repos/acme/app/commits/${head}/status`]: { statuses: o.statuses ?? [] },
    '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': o.reviews ?? [],
    [`/repos/acme/app/commits/${head}/pulls`]: [{ number: 7 }],
  }
  const file = (text: string) => ({ content: Buffer.from(text).toString('base64') })
  const org = o.orgPolicy === undefined ? '{"authors":["ana"],"needsPerson":["**/payments/**"]}' : o.orgPolicy
  if (org !== null) routes['/repos/acme/policies/contents/kage-approve.json'] = file(org)
  if (o.repoPolicy) routes['/repos/acme/app/contents/.github/kage-approve.json?ref=main'] = file(o.repoPolicy)
  let pullReads = 0
  const call: GithubCall = async (method, path, body) => {
    if (method !== 'GET') { writes.push({ method, path, ...(body && { body }) }); return {} }
    if (path === '/repos/acme/app/pulls/7' && pullReads++ && o.movedTo) return { ...pr, head: { ...pr.head, sha: o.movedTo } }
    if (/\/files\?per_page=100&page=\d+$/.test(path) && o.files?.length === 100) return o.files.map(filename => ({ filename }))
    if (path.includes('/contents/') && !(path in routes)) throw new GithubRefused(404, `404 ${path}`)
    if (!(path in routes)) throw new Error(`no route ${path}`)
    return routes[path]
  }
  return { call, writes }
}
const pushed = { repository: { full_name: 'acme/app' }, installation: { id: 41 }, action: 'synchronize', pull_request: { number: 7 } }

function setup(gh: ReturnType<typeof fakeGithub>) {
  const told: string[] = []
  const a = approver({ policyRepo: 'policies', bot: 'kage-me[bot]', call: () => gh.call, allowed: id => id === 41, notify: t => void told.push(t) })
  return { a, told }
}

test('a listed author with green required checks gets one approval on the head commit, with the gates in its text', async () => {
  const gh = fakeGithub(), { a } = setup(gh)
  assert.equal(await a.handle('pull_request', pushed), true)
  assert.equal(gh.writes.length, 1)
  assert.equal(gh.writes[0]!.path, '/repos/acme/app/pulls/7/reviews')
  assert.equal(gh.writes[0]!.body!.event, 'APPROVE')
  assert.equal(gh.writes[0]!.body!.commit_id, 'bbb2222')
  assert.match(String(gh.writes[0]!.body!.body), /Required checks: build passed/)
})

test('a commit Kage already approved gets nothing more', async () => {
  const gh = fakeGithub({ reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('a push that is not approved yet dismisses the approval Kage gave an older commit', async () => {
  const gh = fakeGithub({
    checks: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }],
    reviews: [{ id: 5, state: 'APPROVED', commit_id: 'aaa1111', user: { login: 'kage-me[bot]' } }, { id: 6, state: 'APPROVED', commit_id: 'aaa1111', user: { login: 'kim' } }],
  })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes.map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
  assert.match(String(gh.writes[0]!.body!.message), /bbb2222/)
})

test('the newest run of a check counts, so a rerun that passed unblocks the approval', async () => {
  const gh = fakeGithub({ checks: [{ id: 2, name: 'build', status: 'completed', conclusion: 'success' }, { id: 1, name: 'build', status: 'completed', conclusion: 'failure' }] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.equal(gh.writes[0]?.body?.event, 'APPROVE')
})

test('a high-risk file tells the owner once per commit and approves nothing', async () => {
  const gh = fakeGithub({ files: ['src/payments/charge.py'] }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  await a.handle('check_suite', { ...pushed, action: 'completed', check_suite: { pull_requests: [{ number: 7 }] } })
  assert.deepEqual(gh.writes, [])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /acme\/app#7.*src\/payments\/charge\.py.*https:\/\/gh\/acme\/app\/pull\/7/s)
})

test('an author outside the list is left alone', async () => {
  const gh = fakeGithub({ author: 'eve' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual([gh.writes, told], [[], []])
})

test('a settled status finds its pull request by commit', async () => {
  const gh = fakeGithub()
  await setup(gh).a.handle('status', { repository: { full_name: 'acme/app' }, installation: { id: 41 }, sha: 'bbb2222', state: 'success' })
  assert.equal(gh.writes[0]?.body?.event, 'APPROVE')
})

test('an event from an installation outside the allowed accounts reads and writes nothing', async () => {
  const gh = fakeGithub()
  assert.equal(await setup(gh).a.handle('pull_request', { ...pushed, installation: { id: 77 } }), false)
  assert.deepEqual(gh.writes, [])
})

test('a file moved out of a high-risk path still counts as touching it', async () => {
  const gh = fakeGithub({ files: ['src/billing.py'], renamedFrom: 'src/payments/billing.py' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
  assert.equal(told.length, 1)
})

test('a required check reported as a commit status counts, and a failed one blocks', async () => {
  const pass = fakeGithub({ checks: [], statuses: [{ context: 'build', state: 'success' }] })
  await setup(pass).a.handle('pull_request', pushed)
  assert.equal(pass.writes[0]?.body?.event, 'APPROVE')
  const fail = fakeGithub({ checks: [], statuses: [{ context: 'build', state: 'failure' }] })
  await setup(fail).a.handle('pull_request', pushed)
  assert.deepEqual(fail.writes, [])
})

test('a push that lands while Kage reads the pull request approves nothing, so the files and checks always belong to one commit', async () => {
  const gh = fakeGithub({ movedTo: 'ccc3333' })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('a pull request whose file list fills every page Kage reads goes to the owner, never to an approval', async () => {
  const gh = fakeGithub({ files: Array.from({ length: 100 }, (_, i) => `docs/${i}.md`) }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
  assert.match(told[0] ?? '', /more files than Kage reads/)
})

test('a required check and an approval of Kage on the second page are both seen', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `job-${i}`, status: 'completed', conclusion: 'success' }))
  const others = Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, state: 'COMMENTED', commit_id: 'bbb2222', user: { login: `p${i}` } }))
  const late = fakeGithub({ checks: filler })
  const page2 = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>) => {
    if (path.endsWith('/check-runs?per_page=100&page=2')) return { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] }
    return late.call(method, path, body)
  }
  await approver({ policyRepo: 'policies', bot: 'kage-me[bot]', call: () => page2, allowed: () => true, notify: () => {} }).handle('pull_request', pushed)
  assert.equal(late.writes[0]?.body?.event, 'APPROVE')
  const seen = fakeGithub({ reviews: others })
  const reviews2 = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>) => {
    if (path.endsWith('/reviews?per_page=100&page=2')) return [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }]
    return seen.call(method, path, body)
  }
  await approver({ policyRepo: 'policies', bot: 'kage-me[bot]', call: () => reviews2, allowed: () => true, notify: () => {} }).handle('pull_request', pushed)
  assert.deepEqual(seen.writes, [])
})

test('a policy file in the repo, read from the target branch, wins over the org one', async () => {
  const gh = fakeGithub({ repoPolicy: '{"authors":["kim"]}' }), { a } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('the approval names the policy file it was judged under', async () => {
  const gh = fakeGithub(), { a } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.match(String(gh.writes[0]?.body?.body), /change policy in acme\/policies kage-approve\.json/)
})

test('with no policy in the repo or the org, Kage approves nothing and tells no one', async () => {
  const gh = fakeGithub({ orgPolicy: null }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual([gh.writes, told], [[], []])
})

test('a broken policy file approves nothing and tells the owner once', async () => {
  const gh = fakeGithub({ orgPolicy: '{"authors":"ana"}' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /acme\/policies kage-approve\.json/)
})
