import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileFound, issueReporter } from '../issue-report.ts'

test('the reporter reads the repo from the checkout origin, and files with gh, the body on stdin', async () => {
  const calls: [string, string[], string | undefined][] = []
  const r = issueReporter({ code: '/k', version: () => '0.4.6', perDay: 3, names: () => [] }, async (cmd, args, input) => {
    calls.push([cmd, args, input])
    return cmd === 'git' ? 'git@github.com:some-fork/kage.git\n' : 'https://github.com/some-fork/kage/issues/9\n'
  })
  assert.equal(await r.repo(), 'some-fork/kage')
  assert.equal(await r.file('some-fork/kage', 'T', 'B', ['bug', 'from-agent']), 'https://github.com/some-fork/kage/issues/9')
  assert.deepEqual(calls, [
    ['git', ['-C', '/k', 'remote', 'get-url', 'origin'], undefined],
    ['gh', ['issue', 'create', '--repo', 'some-fork/kage', '--title', 'T', '--body-file', '-', '--label', 'bug', '--label', 'from-agent'], 'B'],
  ])
})

test('the report.repo setting wins over the origin, and no origin with no setting gives no repo', async () => {
  const none = async () => { throw new Error('no origin') }
  assert.equal(await issueReporter({ code: '/k', repo: 'other/kage', version: () => '', perDay: 3, names: () => [] }, none).repo(), 'other/kage')
  assert.equal(await issueReporter({ code: '/k', version: () => '', perDay: 3, names: () => [] }, none).repo(), undefined)
})

test('the reporter finds an open issue by its fingerprint, and comments with the body on stdin', async () => {
  const calls: [string, string[], string | undefined][] = []
  const answers = ['[{"number":12,"url":"https://github.com/a/kage/issues/12"}]', '[]', 'https://github.com/a/kage/issues/12#issuecomment-1\n']
  const r = issueReporter({ code: '/k', version: () => '', perDay: 3, names: () => [] }, async (cmd, args, input) => { calls.push([cmd, args, input]); return answers.shift()! })
  assert.deepEqual(await r.find('a/kage', 'abc123def456'), { number: 12, url: 'https://github.com/a/kage/issues/12' })
  assert.equal(await r.find('a/kage', 'abc123def456'), undefined)
  await r.comment('a/kage', 12, 'seen again on 0.4.7 linux x64')
  const search = ['issue', 'list', '--repo', 'a/kage', '--state', 'open', '--search', '"abc123def456" in:body', '--json', 'number,url', '--limit', '1']
  assert.deepEqual(calls, [
    ['gh', search, undefined],
    ['gh', search, undefined],
    ['gh', ['issue', 'comment', '12', '--repo', 'a/kage', '--body-file', '-'], 'seen again on 0.4.7 linux x64'],
  ])
})

test('a bug the hub found itself is filed once, and a repeat with the same fingerprint gets a seen again comment (#153)', async () => {
  const filed: string[] = [], comments: number[] = []
  const rep = {
    repo: async () => 'a/kage', system: { version: '0.4.7', system: 'darwin arm64' }, perDay: 3,
    file: async (_r: string, _t: string, body: string) => { filed.push(body); return 'https://github.com/a/kage/issues/7' },
    find: async (_r: string, fp: string) => filed.some(b => b.includes(fp)) ? { number: 7, url: 'https://github.com/a/kage/issues/7' } : undefined,
    comment: async (_r: string, n: number) => { comments.push(n) },
  }
  const r = { kind: 'bug' as const, title: 'kage doctor: the slack check did not run', what: 'w', expected: 'e' }
  assert.deepEqual(await fileFound(rep, r), { outcome: 'filed', repo: 'a/kage', url: 'https://github.com/a/kage/issues/7' })
  assert.deepEqual(await fileFound(rep, r), { outcome: 'commented', repo: 'a/kage', url: 'https://github.com/a/kage/issues/7' })
  assert.deepEqual([filed.length, comments], [1, [7]])
  assert.deepEqual(await fileFound({ ...rep, repo: async () => undefined }, r), { outcome: 'no repo', repo: '', url: '' })
})
