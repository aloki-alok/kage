import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueReporter } from '../issue-report.ts'

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
