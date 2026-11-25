import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approver } from '../github-approve.ts'
import { GithubRefused, type GithubCall } from '../github-app.ts'

type Review = { id: number; state: string; commit_id: string; user: { login: string } }
type Run = { id: number; name: string; status: string; conclusion: string | null; app?: { slug: string }; output?: { title: string } }
type Fake = {
  repoPolicy?: string; orgPolicy?: string | null; head?: string; movedTo?: string; statuses?: { context: string; state: string }[]; renamedFrom?: string
  files?: string[]; checks?: Run[]; reviews?: Review[]; author?: string; required?: string[]; draft?: boolean
  activity?: { activity_type: string; actor: { login: string } | null; after?: string }[]; rules?: unknown[]; refuse?: (method: string, path: string) => number | undefined
  open?: { number: number; draft?: boolean; user: { login: string }; head: { sha: string }; base: { ref: string } }[]
}
const POLICY = '{"people":["ana"],"rules":[{"name":"High-risk paths","anyFile":["**/payments/**"],"then":"person"},{"name":"Everything else","then":"approve"}]}'
const NOW = Date.parse('2026-11-25T12:00:00Z')
const created = [{ activity_type: 'push', actor: { login: 'ana' }, after: 'bbb2222' }, { activity_type: 'branch_creation', actor: { login: 'ana' }, after: 'aaa1111' }]

function fakeGithub(o: Fake = {}) {
  const writes: { method: string; path: string; body?: Record<string, unknown> }[] = [], reads: string[] = []
  const head = o.head ?? 'bbb2222'
  const pr = { number: 7, state: 'open', draft: o.draft ?? false, user: { login: o.author ?? 'ana' }, html_url: 'https://gh/acme/app/pull/7', additions: 3, deletions: 1, head: { sha: head, ref: 'fix/a', repo: { full_name: 'acme/app' } }, base: { ref: 'main', repo: { full_name: 'acme/app' } } }
  const routes: Record<string, unknown> = {
    '/repos/acme/app/pulls/7': pr,
    '/repos/acme/app/branches/main': { protected: true, protection: { required_status_checks: { contexts: o.required ?? ['build'] } } },
    '/repos/acme/app/pulls/7/files?per_page=100&page=1': (o.files ?? ['docs/a.md']).map(filename => ({ filename, ...(o.renamedFrom && { previous_filename: o.renamedFrom }) })),
    [`/repos/acme/app/commits/${head}/check-runs?per_page=100&page=1`]: { check_runs: o.checks ?? [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
    [`/repos/acme/app/commits/${head}/status`]: { statuses: o.statuses ?? [] },
    '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': o.reviews ?? [],
    [`/repos/acme/app/commits/${head}/pulls`]: [{ number: 7 }],
    '/repos/acme/app/activity?ref=refs%2Fheads%2Ffix%2Fa&per_page=100': o.activity ?? created,
    '/repos/acme/app/rules/branches/main?per_page=100&page=1': o.rules ?? [],
    '/installation/repositories?per_page=100&page=1': { repositories: [{ full_name: 'acme/app' }] },
    '/repos/acme/app/pulls?state=open&per_page=100&page=1': o.open ?? [{ number: 7, user: pr.user, head: { sha: head }, base: { ref: 'main' } }],
  }
  const file = (text: string) => ({ content: Buffer.from(text).toString('base64') })
  const org = o.orgPolicy === undefined ? POLICY : o.orgPolicy
  if (org !== null) routes['/repos/acme/policies/contents/kage-approve.json'] = file(org)
  if (o.repoPolicy) routes['/repos/acme/app/contents/.github/kage-approve.json?ref=main'] = file(o.repoPolicy)
  let pullReads = 0
  const call: GithubCall = async (method, path, body) => {
    const refused = o.refuse?.(method, path)
    if (refused) throw new GithubRefused(refused, `${refused} ${path}`)
    if (method !== 'GET') { writes.push({ method, path, ...(body && { body }) }); return {} }
    reads.push(path)
    if (path === '/repos/acme/app/pulls/7' && pullReads++ && o.movedTo) return { ...pr, head: { ...pr.head, sha: o.movedTo } }
    if (/\/files\?per_page=100&page=\d+$/.test(path) && o.files?.length === 100) return o.files.map(filename => ({ filename }))
    if (path.includes('/contents/') && !(path in routes)) throw new GithubRefused(404, `404 ${path}`)
    if (!(path in routes)) throw new Error(`no route ${path}`)
    return routes[path]
  }
  const to = (end: string) => writes.filter(w => w.path.endsWith(end))
  return { call, writes, reads, reviews: () => to('/reviews'), checks: () => writes.filter(w => w.path.includes('/check-runs')), dismissals: () => to('/dismissals') }
}
const pushed = { repository: { full_name: 'acme/app' }, installation: { id: 41 }, action: 'synchronize', pull_request: { number: 7 } }

function setup(gh: ReturnType<typeof fakeGithub>, call: GithubCall = gh.call) {
  const told: string[] = [], queued: (() => Promise<unknown>)[] = [], waits: { ms: number; job: () => void }[] = []
  let saved: Record<string, string> = {}
  const a = approver({ policyRepo: 'policies', slug: 'kage-me', call: () => call, allowed: id => id === 41, notify: t => void told.push(t), queue: job => void queued.push(job), later: (ms, job) => void waits.push({ ms, job }), now: () => NOW, seen: { load: () => saved, save: s => { saved = { ...s } } } })
  return { a, told, queued, waits }
}

test('a listed author with green required checks gets one approval on the head commit and a passing Kage policy check', async () => {
  const gh = fakeGithub(), { a } = setup(gh)
  assert.equal(await a.handle('pull_request', pushed), true)
  assert.deepEqual(gh.reviews().map(w => [w.body?.event, w.body?.commit_id]), [['APPROVE', 'bbb2222']])
  assert.match(String(gh.reviews()[0]!.body!.body), /under acme\/policies kage-approve\.json, rule "Everything else"/)
  assert.deepEqual(gh.checks().map(w => [w.method, w.path, w.body?.conclusion, w.body?.head_sha]), [['POST', '/repos/acme/app/check-runs', 'success', 'bbb2222']])
})

test('a commit Kage already approved, with its check already passing, gets nothing more', async () => {
  const gh = fakeGithub({
    reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }],
    checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Kage policy', status: 'completed', conclusion: 'success', app: { slug: 'kage-me' }, output: { title: 'Approved under rule "Everything else".' } }],
  })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('a check that changed state is updated in place, not posted again', async () => {
  const gh = fakeGithub({ checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Kage policy', status: 'in_progress', conclusion: null, app: { slug: 'kage-me' }, output: { title: 'Waiting on required checks' } }] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.checks().map(w => [w.method, w.path]), [['PATCH', '/repos/acme/app/check-runs/2']])
})

test('a required check named Kage policy is never waited on, so Kage cannot wait on itself', async () => {
  const gh = fakeGithub({ required: ['build', 'Kage policy'] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.equal(gh.reviews().length, 1)
})

test('a push still waiting on checks dismisses the approval Kage gave an older commit, never another reviewer\'s', async () => {
  const gh = fakeGithub({
    checks: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }],
    reviews: [{ id: 5, state: 'APPROVED', commit_id: 'aaa1111', user: { login: 'kage-me[bot]' } }, { id: 6, state: 'APPROVED', commit_id: 'aaa1111', user: { login: 'kim' } }],
  })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
  assert.equal(gh.checks()[0]?.body?.status, 'in_progress')
})

test('a push from someone outside people drops Kage\'s approval of that very commit and tells the owner', async () => {
  const gh = fakeGithub({ activity: [{ activity_type: 'push', actor: { login: 'eve' }, after: 'bbb2222' }, ...created], reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
  assert.match(told[0] ?? '', /eve pushed to fix\/a/)
  assert.match(String((gh.checks()[0]?.body?.output as { title: string }).title), /Needs a person/)
})

test('a branch whose creation Kage cannot see in its push history goes to a person', async () => {
  const gh = fakeGithub({ activity: [{ activity_type: 'push', actor: { login: 'ana' } }] }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.match(told[0] ?? '', /cannot see every push to fix\/a/)
})

test('turning a pull request back into a draft drops Kage\'s approval', async () => {
  const gh = fakeGithub({ draft: true, reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] })
  await setup(gh).a.handle('pull_request', { ...pushed, action: 'converted_to_draft' })
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
})

test('a high-risk file tells the owner once per commit and approves nothing', async () => {
  const gh = fakeGithub({ files: ['src/payments/charge.py'] }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  await a.handle('check_suite', { ...pushed, action: 'completed', check_suite: { app: { slug: 'ci' }, pull_requests: [{ number: 7 }] } })
  assert.deepEqual(gh.reviews(), [])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /acme\/app#7.*High-risk paths.*src\/payments\/charge\.py.*https:\/\/gh\/acme\/app\/pull\/7/s)
})

test('a file moved out of a high-risk path still counts as touching it', async () => {
  const gh = fakeGithub({ files: ['src/billing.py'], renamedFrom: 'src/payments/billing.py' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual([gh.reviews(), told.length], [[], 1])
})

test('an author outside people is left alone: no approval, no check, no message', async () => {
  const gh = fakeGithub({ author: 'eve' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual([gh.writes, told], [[], []])
})

test('when GitHub refuses the check, Kage still approves and tells the owner once what permission is missing', async () => {
  const gh = fakeGithub({ refuse: (method, path) => method === 'POST' && path.endsWith('/check-runs') ? 403 : undefined }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  await a.handle('pull_request', pushed)
  assert.equal(gh.reviews().length, 2)
  assert.equal(told.length, 1)
  assert.match(told[0]!, /Checks: Read and write/)
})

const reviewsDown = (status: number, down = { on: true }) => ({ down, gh: fakeGithub({ refuse: (method, path) => down.on && method === 'POST' && path.endsWith('/reviews') ? status : undefined }) })
const runWaits = async (s: ReturnType<typeof setup>) => {
  while (s.waits.length) { s.waits.shift()!.job(); await s.queued.shift()!() }
}

test('a GitHub 5xx on the approval tells the owner nothing, and one retry approves the pull request once GitHub is back', async () => {
  const { down, gh } = reviewsDown(502), s = setup(gh)
  for (let i = 0; i < 3; i++) await s.a.handle('check_suite', { ...pushed, action: 'completed', check_suite: { pull_requests: [{ number: 7 }] } })
  assert.deepEqual([s.told, s.waits.length, pullReads(gh)], [[], 1, 2])
  down.on = false
  await runWaits(s)
  assert.deepEqual(gh.reviews().map(w => w.body?.commit_id), ['bbb2222'])
  assert.deepEqual(s.told, [])
})

test('a pull request GitHub keeps failing for every retry reaches the owner as one message per outage, naming it', async () => {
  const { gh } = reviewsDown(500), s = setup(gh)
  await s.a.handle('pull_request', pushed)
  await runWaits(s)
  await s.a.handle('pull_request', pushed)
  await runWaits(s)
  assert.equal(s.told.length, 1)
  assert.match(s.told[0]!, /acme\/app#7/)
  assert.match(s.told[0]!, /500/)
})

test('a GitHub 4xx on the approval is not retried, so the owner hears at once', async () => {
  const { gh } = reviewsDown(422), s = setup(gh)
  await assert.rejects(s.a.handle('pull_request', pushed), /422/)
  assert.equal(s.waits.length, 0)
})

test('a settled status finds its pull request by commit', async () => {
  const gh = fakeGithub()
  await setup(gh).a.handle('status', { repository: { full_name: 'acme/app' }, installation: { id: 41 }, sha: 'bbb2222', state: 'success' })
  assert.equal(gh.reviews()[0]?.body?.event, 'APPROVE')
})

test('an event from an installation outside the allowed accounts reads and writes nothing', async () => {
  const gh = fakeGithub()
  assert.equal(await setup(gh).a.handle('pull_request', { ...pushed, installation: { id: 77 } }), false)
  assert.deepEqual([gh.reads, gh.writes], [[], []])
})

test('a required check reported as a commit status counts, and a failed one blocks', async () => {
  const pass = fakeGithub({ checks: [], statuses: [{ context: 'build', state: 'success' }] })
  await setup(pass).a.handle('pull_request', pushed)
  assert.equal(pass.reviews().length, 1)
  const fail = fakeGithub({ checks: [], statuses: [{ context: 'build', state: 'failure' }] })
  await setup(fail).a.handle('pull_request', pushed)
  assert.deepEqual(fail.reviews(), [])
})

test('the newest run of a check counts, so a rerun that passed unblocks the approval', async () => {
  const gh = fakeGithub({ checks: [{ id: 2, name: 'build', status: 'completed', conclusion: 'success' }, { id: 1, name: 'build', status: 'completed', conclusion: 'failure' }] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.equal(gh.reviews().length, 1)
})

test('a push that lands while Kage reads the pull request writes nothing, so the facts always belong to one commit', async () => {
  const gh = fakeGithub({ movedTo: 'ccc3333' })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('a pull request whose file list fills every page Kage reads goes to the owner, never to an approval', async () => {
  const gh = fakeGithub({ files: Array.from({ length: 100 }, (_, i) => `docs/${i}.md`) }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.match(told[0] ?? '', /more files than Kage reads/)
})

test('a required check and an approval of Kage on the second page are both seen', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `job-${i}`, status: 'completed', conclusion: 'success' }))
  const late = fakeGithub({ checks: filler })
  await setup(late, async (method, path, body) => path.endsWith('/check-runs?per_page=100&page=2') ? { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] } : late.call(method, path, body)).a.handle('pull_request', pushed)
  assert.equal(late.reviews().length, 1)
  const others = Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, state: 'COMMENTED', commit_id: 'bbb2222', user: { login: `p${i}` } }))
  const seen = fakeGithub({ reviews: others })
  await setup(seen, async (method, path, body) => path.endsWith('/reviews?per_page=100&page=2') ? [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] : seen.call(method, path, body)).a.handle('pull_request', pushed)
  assert.deepEqual(seen.reviews(), [])
})

test('a policy file in the repo, read from the target branch, wins over the org one', async () => {
  const gh = fakeGithub({ repoPolicy: '{"people":["kim"],"rules":[{"name":"All","then":"approve"}]}' })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
})

test('the first policy shape still works, so a policy repo can move to rules after this ships', async () => {
  const gh = fakeGithub({ orgPolicy: '{"authors":["ana"],"needsPerson":["**/payments/**"]}' })
  await setup(gh).a.handle('pull_request', pushed)
  assert.equal(gh.reviews().length, 1)
})

test('with no policy in the repo or the org, Kage approves nothing and tells no one', async () => {
  const gh = fakeGithub({ orgPolicy: null }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual([gh.writes, told], [[], []])
})

test('a broken policy file approves nothing and tells the owner once', async () => {
  const gh = fakeGithub({ orgPolicy: '{"people":"ana"}' }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.writes, [])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /acme\/policies kage-approve\.json/)
})

test('a pull request merged into the branch by someone outside people counts as their push', async () => {
  const gh = fakeGithub({ activity: [{ activity_type: 'pr_merge', actor: { login: 'eve' }, after: 'bbb2222' }, ...created] }), { a, told } = setup(gh)
  await a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.match(told[0] ?? '', /eve pushed to fix\/a/)
})

test('a head commit missing from the push history waits instead of approving', async () => {
  const gh = fakeGithub({ activity: created.slice(1) })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.equal(gh.checks()[0]?.body?.status, 'in_progress')
})

test('a check that a ruleset requires is waited on like one branch protection requires', async () => {
  const gh = fakeGithub({ required: [], rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'e2e' }] } }] })
  await setup(gh).a.handle('pull_request', pushed)
  assert.deepEqual(gh.reviews(), [])
  assert.match(String((gh.checks()[0]?.body?.output as { summary: string }).summary), /Waiting on e2e/)
})

test('an update sends only the fields GitHub lets a check run change, and a finished check that must wait again is posted anew', async () => {
  const done = { id: 2, name: 'Kage policy', status: 'completed', conclusion: 'neutral', app: { slug: 'kage-me' }, output: { title: 'old' } }
  const patch = fakeGithub({ checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, done] })
  await setup(patch).a.handle('pull_request', pushed)
  assert.deepEqual([patch.checks()[0]?.method, 'head_sha' in (patch.checks()[0]?.body ?? {}), 'name' in (patch.checks()[0]?.body ?? {})], ['PATCH', false, false])
  const reopen = fakeGithub({ checks: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }, done] })
  await setup(reopen).a.handle('pull_request', pushed)
  assert.deepEqual(reopen.checks().map(w => w.method), ['POST'])
})

test('a sweep drops an approval Kage gave a pull request whose author is no longer in people', async () => {
  const gh = fakeGithub({
    open: [{ number: 7, user: { login: 'eve' }, head: { sha: 'bbb2222' }, base: { ref: 'main' } }],
    reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }],
  })
  await setup(gh).a.sweep(41)
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
})

test('a changed policy file queues a sweep of the installation, so open pull requests are judged under the new rules', async () => {
  let policy = POLICY
  const gh = fakeGithub()
  const call: GithubCall = async (method, path, body) => path === '/repos/acme/policies/contents/kage-approve.json' ? { content: Buffer.from(policy).toString('base64') } : gh.call(method, path, body)
  const { a, queued } = setup(gh, call)
  await a.handle('pull_request', pushed)
  assert.equal(queued.length, 0)
  policy = POLICY.replace('Everything else', 'All the rest')
  await a.handle('pull_request', pushed)
  assert.equal(queued.length, 1)
})

test('a sweep judges a pull request Kage approved, and drops the approval when a push came from outside people', async () => {
  const gh = fakeGithub({
    open: [{ number: 7, user: { login: 'ana' }, head: { sha: 'bbb2222' }, base: { ref: 'main' } }],
    reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }],
    activity: [{ activity_type: 'push', actor: { login: 'eve' }, after: 'bbb2222' }, ...created],
  })
  await setup(gh).a.sweep(41)
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
})


const pullReads = (gh: ReturnType<typeof fakeGithub>) => gh.reads.filter(p => p === '/repos/acme/app/pulls/7').length

test('a sweep never posts a new approval, so an open pull request nobody is working on stays quiet', async () => {
  const gh = fakeGithub()
  await setup(gh).a.sweep(41)
  assert.deepEqual([gh.writes, pullReads(gh)], [[], 0])
})

test('a sweep judges a pull request Kage approved every time, so a rerun check that failed while Kage was down drops the approval', async () => {
  const gh = fakeGithub({ reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }], checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'failure' }] }), { a } = setup(gh)
  await a.sweep(41)
  await a.sweep(41)
  assert.equal(pullReads(gh), 4)
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals', '/repos/acme/app/pulls/7/reviews/5/dismissals'])
})

test('a sweep drops the approval of a pull request turned back into a draft while Kage was down', async () => {
  const gh = fakeGithub({ draft: true, open: [{ number: 7, draft: true, user: { login: 'ana' }, head: { sha: 'bbb2222' }, base: { ref: 'main' } }], reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] })
  await setup(gh).a.sweep(41)
  assert.deepEqual(gh.dismissals().map(w => w.path), ['/repos/acme/app/pulls/7/reviews/5/dismissals'])
})

test('approvals a sweep drops for a person reach the owner as one message, and a later event on the same commit adds none', async () => {
  const gh = fakeGithub({ files: ['src/payments/x.ts'], reviews: [{ id: 5, state: 'APPROVED', commit_id: 'bbb2222', user: { login: 'kage-me[bot]' } }] }), { a, told } = setup(gh)
  await a.sweep(41)
  await a.handle('pull_request', pushed)
  assert.equal(told.length, 1)
  assert.match(told[0]!, /^Kage checked the open pull requests, and 1 need a person:\n• acme\/app#7: Rule "High-risk paths"/)
})

test('a sweep leaves a new head unapproved even when Kage approved an older commit, so only the push itself brings an approval', async () => {
  const gh = fakeGithub({ reviews: [{ id: 5, state: 'APPROVED', commit_id: 'aaa1111', user: { login: 'kage-me[bot]' } }] })
  await setup(gh).a.sweep(41)
  assert.deepEqual(gh.reviews(), [])
})
