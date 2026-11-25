import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRule, parsePolicy } from '../github-policy.ts'

const text = JSON.stringify({
  people: ['ana', 'Ben'],
  rules: [
    { name: 'Releases', targets: ['Production'], then: 'person' },
    { name: 'High-risk paths', anyFile: ['**/migrations/**', '.github/workflows/**'], then: 'person' },
    { name: 'Big changes', moreLinesThan: 500, then: 'person' },
    { name: 'Everything else', then: 'approve' },
  ],
})
const policy = parsePolicy(text, 'acme/policies kage-approve.json')
const pr = (o: Partial<{ base: string; files: string[]; lines: number }> = {}) => ({ base: 'main', files: ['src/a.ts'], lines: 10, ...o })

test('the first rule whose conditions all hold decides', () => {
  if ('error' in policy) throw new Error(policy.error)
  assert.equal(firstRule(policy, pr())?.name, 'Everything else')
  assert.equal(firstRule(policy, pr({ base: 'Production', files: ['db/migrations/1.sql'] }))?.name, 'Releases')
  assert.equal(firstRule(policy, pr({ files: ['src/a.ts', 'db/migrations/1.sql'] }))?.name, 'High-risk paths')
  assert.equal(firstRule(policy, pr({ lines: 501 }))?.name, 'Big changes')
  assert.equal(firstRule(policy, pr({ lines: 500 }))?.name, 'Everything else')
})

test('a rule with no catch-all leaves an uncovered pull request with no rule', () => {
  const only = parsePolicy(JSON.stringify({ people: ['ana'], rules: [{ name: 'Docs', anyFile: ['docs/**'], then: 'approve' }] }), 's')
  if ('error' in only) throw new Error(only.error)
  assert.equal(firstRule(only, pr()), undefined)
})

test('globs reach into dot folders, whether or not the glob names the dot', () => {
  if ('error' in policy) throw new Error(policy.error)
  assert.equal(firstRule(policy, pr({ files: ['.github/workflows/ci.yml'] }))?.name, 'High-risk paths')
  assert.equal(firstRule(policy, pr({ files: ['app/.cache/migrations/x.py'] }))?.name, 'High-risk paths')
})

test('people compare without case, and the policy keeps where it came from', () => {
  if ('error' in policy) throw new Error(policy.error)
  assert.deepEqual(policy.people, ['ana', 'ben'])
  assert.equal(policy.source, 'acme/policies kage-approve.json')
})

test('the first policy shape, authors and needsPerson, reads as people with a high-risk rule and a catch-all', () => {
  const old = parsePolicy('{"authors":["ana"],"needsPerson":["**/payments/**"]}', 's')
  if ('error' in old) throw new Error(old.error)
  assert.deepEqual(old.people, ['ana'])
  assert.equal(firstRule(old, pr({ files: ['src/payments/x.ts'] }))?.then, 'person')
  assert.equal(firstRule(old, pr())?.then, 'approve')
})

test('a broken file names its source and the bad field', () => {
  for (const [bad, field] of [
    ['{', 'not valid JSON'],
    ['{"people":["ana"],"rules":[{"name":"x","then":"merge"}]}', 'rules.0.then'],
    ['{"people":["ana"],"rules":[]}', 'rules'],
    ['{"people":[],"rules":[{"name":"x","then":"approve"}]}', 'people'],
    ['{"people":["ana"],"rules":[{"name":"x","then":"approve","anyfile":["a"]}]}', 'anyfile'],
  ] as const) {
    const r = parsePolicy(bad, 'acme/policies kage-approve.json')
    assert.ok('error' in r, bad)
    assert.match(r.error, /^acme\/policies kage-approve\.json/)
    assert.ok(r.error.includes(field), `${bad} -> ${r.error}`)
  }
})
