import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixer } from '../github-fix.ts'
import type { FixMode } from '../../core/github-fix.ts'

const base = { repository: { full_name: 'acme/app' }, installation: { id: 41 } }
const failed = (sha = 'abc1234def', prs = [{ number: 7 }]) => ({ ...base, action: 'completed', check_suite: { conclusion: 'failure', head_sha: sha, app: { slug: 'ci' }, pull_requests: prs } })
const closed = { ...base, action: 'closed', pull_request: { number: 7 } }

function setup(mode: FixMode = 'on', o: { perPr?: number; head?: () => string; author?: number; saved?: Record<string, unknown> } = {}) {
  const calls: string[] = [], told: string[] = []
  let saved = (o.saved ?? {}) as never
  const f = fixer({
    mode, perPr: o.perPr ?? 3, ownerId: 1, slug: 'kage-me', allowed: id => id === 41, notify: t => void told.push(t),
    seen: { load: () => saved, save: s => { saved = JSON.parse(JSON.stringify(s)) as never } },
    call: () => async (_method, path) => {
      calls.push(path)
      if (path.endsWith('/pulls')) return [{ number: 7 }]
      return { number: 7, title: 'Faster calls', html_url: 'https://gh/acme/app/pull/7', state: 'open', draft: false, user: { id: o.author ?? 1 }, labels: [], head: { sha: o.head?.() ?? 'abc1234def', ref: 'fix/a', repo: { full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } } }
    },
  })
  return { f, calls, told, saved: () => saved as Record<string, unknown> }
}

test('a failed suite on the owner\'s pull request starts one live fix, and the same commit starts no second', async () => {
  const { f, saved } = setup()
  const first = await f.handle('check_suite', failed())
  assert.equal(first.length, 1)
  assert.deepEqual([first[0]!.live, first[0]!.thread, first[0]!.headline], [true, 'acme/app#7', 'Checks failed on acme/app#7 Faster calls'])
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(saved(), { 'acme/app#7': { keys: ['abc1234def:red checks'], tries: 1 } })
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
  assert.deepEqual(calls, ['/repos/acme/app/commits/abc1234def/pulls', '/repos/acme/app/pulls/7'])
})

test('a pull request someone else opened, or an installation that is not allowed, starts nothing', async () => {
  assert.deepEqual(await setup('on', { author: 9 }).f.handle('check_suite', failed()), [])
  const other = setup()
  assert.deepEqual(await other.f.handle('check_suite', { ...failed(), installation: { id: 77 } }), [])
  assert.deepEqual(other.calls, [])
})

test('after its fixes are used up the owner is told once, and closing the pull request clears the count', async () => {
  let head = 'aaa1111'
  const { f, told } = setup('on', { perPr: 2, head: () => head })
  for (const sha of ['aaa1111', 'bbb2222']) { head = sha; assert.equal((await f.handle('check_suite', failed(sha))).length, 1) }
  for (const sha of ['ccc3333', 'ddd4444']) { head = sha; assert.deepEqual(await f.handle('check_suite', failed(sha)), []) }
  assert.equal(told.length, 1)
  assert.match(told[0]!, /acme\/app#7 got stuck again after 2 fixes.*https:\/\/gh\/acme\/app\/pull\/7/)
  await f.handle('pull_request', closed)
  head = 'eee5555'
  assert.equal((await f.handle('check_suite', failed('eee5555'))).length, 1)
})

test('fixes already started are remembered across a restart', async () => {
  const { f } = setup('on', { saved: { 'acme/app#7': { keys: ['abc1234def:red checks'], tries: 1 } } })
  assert.deepEqual(await f.handle('check_suite', failed()), [])
})
