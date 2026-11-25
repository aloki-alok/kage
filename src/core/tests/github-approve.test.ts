import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalEvent, approvalVerdict, approveSetting, checkRun, type PrFacts } from '../github-approve.ts'
import { parsePolicy, type ApprovePolicy } from '../github-policy.ts'

const policy = parsePolicy(JSON.stringify({
  people: ['ana', 'Ben'],
  rules: [
    { name: 'Releases', targets: ['Production'], then: 'person' },
    { name: 'High-risk paths', anyFile: ['**/payments/**', '**/migrations/**'], then: 'person' },
    { name: 'Everything else', then: 'approve' },
  ],
}), 'acme/policies kage-approve.json') as ApprovePolicy
const facts = (o: Partial<PrFacts> = {}): PrFacts => ({
  repo: 'acme/app', number: 7, sha: 'abc1234def', author: 'ana', base: 'main', branch: 'fix/a', open: true, draft: false, fromFork: false,
  baseProtected: true, requiredChecks: ['build'], checks: [{ name: 'build', result: 'pass' }, { name: 'lint', result: 'fail' }],
  files: ['docs/a.md', 'src/x.ts'], filesCut: false, lines: 12, pushers: ['ana'], headPushed: true, labels: [], versionOnly: false, ...o,
})
const verdict = (o: Partial<PrFacts> = {}, p = policy) => approvalVerdict(p, facts(o))

test('a listed author whose pushes are all listed, with green required checks, is approved under the rule that matched', () => {
  const v = verdict()
  assert.equal(v.kind, 'approve')
  assert.equal(v.rule, 'Everything else')
  assert.match(v.body ?? '', /^Approved by Kage under acme\/policies kage-approve\.json, rule "Everything else"\./)
  assert.match(v.body ?? '', /^- Commit: abc1234$/m)
  assert.match(v.body ?? '', /^- Author: ana$/m)
  assert.match(v.body ?? '', /^- Pushed by: ana$/m)
  assert.match(v.body ?? '', /^- Required checks: build passed$/m)
  assert.match(v.body ?? '', /^- Files: 2$/m)
})

test('people match without case', () => {
  assert.equal(verdict({ author: 'ben', pushers: ['BEN'] }).kind, 'approve')
})

test('a push from someone outside people sends the pull request to a person, naming the pusher', () => {
  const v = verdict({ pushers: ['ana', 'eve'] })
  assert.deepEqual([v.kind, v.code], ['person', 'pusher-not-listed'])
  assert.match(v.why, /eve pushed to fix\/a/)
})

test('a branch whose pushes Kage cannot all see goes to a person', () => {
  assert.deepEqual([verdict({ pushers: undefined }).kind, verdict({ pushers: undefined }).code], ['person', 'pushes-unseen'])
})

test('a head commit the push history does not show yet waits, so a push GitHub has not logged cannot slip through', () => {
  assert.deepEqual([verdict({ headPushed: false }).kind, verdict({ headPushed: false }).code], ['wait', 'push-history-behind'])
  assert.equal(verdict({ headPushed: false, pushers: ['eve'] }).code, 'pusher-not-listed')
})

test('an author outside people, or a closed pull request, is skipped with nothing to show', () => {
  for (const o of [{ author: 'eve' }, { open: false }]) assert.equal(verdict(o).kind, 'skip', JSON.stringify(o))
})

test('a draft, a fork or an unprotected base stops with a fix an agent can act on', () => {
  for (const [o, code] of [[{ draft: true }, 'draft'], [{ fromFork: true }, 'fork'], [{ baseProtected: false }, 'base-unprotected']] as const) {
    const v = verdict(o)
    assert.deepEqual([v.kind, v.code], ['stop', code])
    assert.ok(v.fix.length > 0, code)
  }
})

test('a rule that asks for a person names the rule and what matched', () => {
  const risky = verdict({ files: ['docs/a.md', 'billing/payments/charge.py'] })
  assert.deepEqual([risky.kind, risky.code, risky.rule], ['person', 'rule', 'High-risk paths'])
  assert.match(risky.why, /billing\/payments\/charge\.py/)
  const release = verdict({ base: 'Production' })
  assert.deepEqual([release.kind, release.rule], ['person', 'Releases'])
  assert.match(release.why, /targets Production/)
})

test('a person rule wins over a pending check, so the person hears at once', () => {
  assert.equal(verdict({ files: ['db/migrations/1.sql'], checks: [] }).kind, 'person')
})

test('a pull request no rule covers is not approved, and the fix says to add a rule', () => {
  const narrow = parsePolicy('{"people":["ana"],"rules":[{"name":"Docs","anyFile":["docs/**"],"then":"approve"}]}', 'p') as ApprovePolicy
  const v = verdict({ files: ['src/x.ts'] }, narrow)
  assert.deepEqual([v.kind, v.code], ['stop', 'no-rule'])
  assert.match(v.fix, /rule/)
})

test('a required check that is missing or running waits, and one that failed stops and names it', () => {
  assert.deepEqual([verdict({ checks: [] }).kind, verdict({ checks: [] }).code], ['wait', 'checks-pending'])
  const failed = verdict({ checks: [{ name: 'build', result: 'fail' }] })
  assert.deepEqual([failed.kind, failed.code], ['stop', 'checks-failed'])
  assert.match(failed.why, /build/)
})

test('a repo with no required checks is approved on the other gates', () => {
  assert.match(verdict({ requiredChecks: [], checks: [] }).body ?? '', /Required checks: none set on this branch/)
})

test('more files than Kage read, or a change to a policy file, always goes to a person', () => {
  assert.equal(verdict({ filesCut: true }).code, 'too-many-files')
  for (const file of ['.github/kage-approve.json', 'kage-approve.json']) assert.equal(verdict({ files: [file] }).code, 'policy-change', file)
})

test('the check run carries the verdict as data an agent can read', () => {
  const approved = checkRun(policy, facts(), verdict())
  assert.deepEqual([approved.name, approved.head_sha, approved.status, approved.conclusion], ['Kage policy', 'abc1234def', 'completed', 'success'])
  const risky = facts({ files: ['src/payments/x.ts'] })
  const run = checkRun(policy, risky, approvalVerdict(policy, risky))
  assert.equal(run.conclusion, 'neutral')
  assert.match(run.output.title, /Needs a person/)
  const data = JSON.parse(/```json\n([\s\S]+)\n```/.exec(run.output.text)![1]!)
  assert.deepEqual(data, { verdict: 'person', code: 'rule', rule: 'High-risk paths', commit: 'abc1234def', why: data.why, fix: data.fix, policy: 'acme/policies kage-approve.json' })
  const waiting = checkRun(policy, facts({ checks: [] }), verdict({ checks: [] }))
  assert.deepEqual([waiting.status, waiting.conclusion], ['in_progress', undefined])
})

const at = { repository: { full_name: 'acme/app' }, installation: { id: 41 } }
test('pull request changes, a finished check suite and a settled status each name what to check again', () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited'])
    assert.deepEqual(approvalEvent('pull_request', { ...at, action, pull_request: { number: 7 } }, 'kage-me'), { repo: 'acme/app', installation: 41, prs: [7] }, action)
  assert.deepEqual(approvalEvent('check_suite', { ...at, action: 'completed', check_suite: { app: { slug: 'ci' }, pull_requests: [{ number: 7 }, { number: 9 }] } }, 'kage-me'), { repo: 'acme/app', installation: 41, prs: [7, 9] })
  assert.deepEqual(approvalEvent('status', { ...at, sha: 'abc', state: 'success' }, 'kage-me'), { repo: 'acme/app', installation: 41, sha: 'abc' })
})

test('Kage\'s own check suite, a closed pull request, a running suite, a pending status or a comment start no check', () => {
  assert.equal(approvalEvent('check_suite', { ...at, action: 'completed', check_suite: { app: { slug: 'kage-me' }, pull_requests: [{ number: 7 }] } }, 'kage-me'), undefined)
  assert.equal(approvalEvent('pull_request', { ...at, action: 'closed', pull_request: { number: 7 } }, 'kage-me'), undefined)
  assert.equal(approvalEvent('check_suite', { ...at, action: 'requested', check_suite: { pull_requests: [{ number: 7 }] } }, 'kage-me'), undefined)
  assert.equal(approvalEvent('status', { ...at, sha: 'abc', state: 'pending' }, 'kage-me'), undefined)
  assert.equal(approvalEvent('issue_comment', { ...at, action: 'created' }, 'kage-me'), undefined)
  assert.equal(approvalEvent('pull_request', { action: 'opened', pull_request: { number: 7 } }, 'kage-me'), undefined)
})

test('approvals are off with no setting, and on they read the org policy from .github unless another repo is named', () => {
  assert.equal(approveSetting(undefined), undefined)
  assert.deepEqual(approveSetting({}), { policyRepo: '.github' })
  assert.deepEqual(approveSetting({ policyRepo: 'policies' }), { policyRepo: 'policies' })
})

const releasePolicy = parsePolicy(JSON.stringify({
  people: ['ana', 'github-actions[bot]'],
  rules: [
    { name: 'Releases', author: ['github-actions[bot]'], branch: ['release-please--*'], onlyFiles: ['CHANGELOG.md'], then: 'merge' },
    { name: 'Everything else', then: 'approve' },
  ],
}), 's') as ApprovePolicy
const releaseFacts = { author: 'github-actions[bot]', branch: 'release-please--branches--main', files: ['CHANGELOG.md'], pushers: ['github-actions[bot]'] }

test('a release that passes its rule and its required checks is approved and marked to merge, and an ordinary approval is not', () => {
  const v = verdict(releaseFacts, releasePolicy)
  assert.deepEqual([v.kind, v.rule, v.merge], ['approve', 'Releases', true])
  assert.match(v.body ?? '', /Kage merges it now\./)
  assert.equal(verdict({}, releasePolicy).merge, undefined)
})

test('a release still waits on its required checks before Kage merges it', () => {
  const v = verdict({ ...releaseFacts, checks: [{ name: 'build', result: 'pending' }] }, releasePolicy)
  assert.deepEqual([v.kind, v.merge], ['wait', undefined])
})

test('the hold label sends any pull request to a person, so a release can be stopped by hand', () => {
  for (const o of [releaseFacts, {}]) {
    const v = verdict({ ...o, labels: ['Hold'] }, releasePolicy)
    assert.deepEqual([v.kind, v.code], ['person', 'hold'])
  }
})
