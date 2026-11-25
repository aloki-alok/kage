import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalEvent, approvalVerdict, approveSetting, parsePolicy, type PrFacts } from '../github-approve.ts'

const policy = { authors: ['ana', 'Ben'], riskyPaths: ['**/payments/**', '**/migrations/**'], source: 'acme/policies kage-approve.json' }
const facts = (o: Partial<PrFacts> = {}): PrFacts => ({
  repo: 'acme/app', number: 7, sha: 'abc1234def', author: 'ana', open: true, draft: false, fromFork: false,
  baseProtected: true, requiredChecks: ['build'], checks: [{ name: 'build', result: 'pass' }, { name: 'lint', result: 'fail' }],
  files: ['docs/a.md', 'src/x.ts'], filesCut: false, approvedShas: [], ...o,
})

test('a listed author with green required checks and no risky file gets an approval that names each gate', () => {
  const v = approvalVerdict(policy, facts())
  assert.equal(v.kind, 'approve')
  if (v.kind !== 'approve') return
  assert.match(v.body, /Commit: abc1234\b/)
  assert.match(v.body, /Author: ana/)
  assert.match(v.body, /Required checks: build passed/)
  assert.match(v.body, /High-risk paths: none touched/)
})

test('the author list matches GitHub logins without case', () => {
  assert.equal(approvalVerdict(policy, facts({ author: 'ben' })).kind, 'approve')
})

test('an author outside the list, a draft, a fork, a closed pull request or an unprotected base is skipped', () => {
  for (const o of [{ author: 'eve' }, { draft: true }, { fromFork: true }, { open: false }, { baseProtected: false }])
    assert.equal(approvalVerdict(policy, facts(o)).kind, 'skip', JSON.stringify(o))
})

test('a commit this app already approved is skipped, so a redelivered event posts nothing twice', () => {
  assert.equal(approvalVerdict(policy, facts({ approvedShas: ['abc1234def'] })).kind, 'skip')
})

test('a required check that is missing or still running waits, and one that failed is skipped', () => {
  assert.equal(approvalVerdict(policy, facts({ checks: [] })).kind, 'wait')
  assert.equal(approvalVerdict(policy, facts({ checks: [{ name: 'build', result: 'pending' }] })).kind, 'wait')
  const failed = approvalVerdict(policy, facts({ checks: [{ name: 'build', result: 'fail' }] }))
  assert.equal(failed.kind, 'skip')
  assert.match(failed.kind === 'skip' ? failed.why : '', /build/)
})

test('a repo with no required checks is approved on the other gates', () => {
  const v = approvalVerdict(policy, facts({ requiredChecks: [], checks: [] }))
  assert.equal(v.kind, 'approve')
  assert.match(v.kind === 'approve' ? v.body : '', /Required checks: none set on this branch/)
})

test('a file on a high-risk path goes to a human and names that file', () => {
  const v = approvalVerdict(policy, facts({ files: ['docs/a.md', 'billing/payments/charge.py'] }))
  assert.equal(v.kind, 'human')
  assert.match(v.kind === 'human' ? v.why : '', /billing\/payments\/charge\.py/)
})

test('a pull request with more files than Kage read goes to a human', () => {
  assert.equal(approvalVerdict(policy, facts({ filesCut: true })).kind, 'human')
})

test('a high-risk file wins over a pending check, so the human hears at once', () => {
  assert.equal(approvalVerdict(policy, facts({ files: ['db/migrations/1.sql'], checks: [] })).kind, 'human')
})

const at = { repository: { full_name: 'acme/app' }, installation: { id: 41 } }
test('a new or pushed pull request, a finished check suite and a settled status each name what to check again', () => {
  assert.deepEqual(approvalEvent('pull_request', { ...at, action: 'synchronize', pull_request: { number: 7 } }), { repo: 'acme/app', installation: 41, prs: [7] })
  assert.deepEqual(approvalEvent('check_suite', { ...at, action: 'completed', check_suite: { pull_requests: [{ number: 7 }, { number: 9 }] } }), { repo: 'acme/app', installation: 41, prs: [7, 9] })
  assert.deepEqual(approvalEvent('status', { ...at, sha: 'abc', state: 'success' }), { repo: 'acme/app', installation: 41, sha: 'abc' })
})

test('a closed pull request, a check suite still running, a pending status or a comment start no check', () => {
  assert.equal(approvalEvent('pull_request', { ...at, action: 'closed', pull_request: { number: 7 } }), undefined)
  assert.equal(approvalEvent('check_suite', { ...at, action: 'requested', check_suite: { pull_requests: [{ number: 7 }] } }), undefined)
  assert.equal(approvalEvent('status', { ...at, sha: 'abc', state: 'pending' }), undefined)
  assert.equal(approvalEvent('issue_comment', { ...at, action: 'created' }), undefined)
  assert.equal(approvalEvent('pull_request', { action: 'opened', pull_request: { number: 7 } }), undefined)
})

test('a policy file gives authors and the paths that need a person, and a bad file says what is wrong', () => {
  assert.deepEqual(parsePolicy('{"authors":["ana"],"needsPerson":["**/payments/**"]}', 'acme/policies'), { authors: ['ana'], riskyPaths: ['**/payments/**'], source: 'acme/policies' })
  assert.deepEqual(parsePolicy('{"authors":["ana"]}', 'x'), { authors: ['ana'], riskyPaths: [], source: 'x' })
  assert.match((parsePolicy('{"authors":[]}', 'x') as { error: string }).error, /authors/)
  assert.match((parsePolicy('{"authors":["ana"],"approveAll":true}', 'x') as { error: string }).error, /approveAll|Unrecognized/)
  assert.match((parsePolicy('authors: [ana]', 'x') as { error: string }).error, /not valid JSON/)
})

test('a change to any policy file always goes to a person, so a pull request cannot loosen its own rules', () => {
  for (const file of ['.github/kage-approve.json', 'kage-approve.json'])
    assert.equal(approvalVerdict({ ...policy, riskyPaths: [] }, facts({ files: [file] })).kind, 'human', file)
})

test('a high-risk path inside a folder whose name starts with a dot still counts', () => {
  assert.equal(approvalVerdict(policy, facts({ files: ['.internal/migrations/1.sql'] })).kind, 'human')
  assert.equal(approvalVerdict({ ...policy, riskyPaths: ['.github/**'] }, facts({ files: ['.github/.hidden/a.yml'] })).kind, 'human')
})

test('the approval names the policy it was judged under', () => {
  const v = approvalVerdict(policy, facts())
  assert.match(v.kind === 'approve' ? v.body : '', /change policy in acme\/policies kage-approve\.json/)
})

test('approvals are off with no setting, and on they read the org policy from .github unless another repo is named', () => {
  assert.equal(approveSetting(undefined), undefined)
  assert.deepEqual(approveSetting({}), { policyRepo: '.github' })
  assert.deepEqual(approveSetting({ policyRepo: 'policies' }), { policyRepo: 'policies' })
})
