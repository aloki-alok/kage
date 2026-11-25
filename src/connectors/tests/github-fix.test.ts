import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixer } from '../github-fix.ts'
import type { FixMode } from '../../core/github-fix.ts'

const base = { repository: { full_name: 'acme/app' }, installation: { id: 41 } }
const failed = (sha = 'abc1234def', prs = [{ number: 7 }]) => ({ ...base, action: 'completed', check_suite: { conclusion: 'failure', head_sha: sha, app: { slug: 'ci' }, pull_requests: prs } })
const closed = { ...base, action: 'closed', pull_request: { number: 7 } }

function setup(mode: FixMode = 'on', o: { perPr?: number; head?: () => string; author?: number; saved?: Record<string, unknown>; grace?: number; now?: () => number; suites?: () => string[]; reviews?: () => { state: string; user: { login: string } }[]; allowed?: () => boolean; pending?: Record<string, unknown> } = {}) {
  const calls: string[] = [], told: string[] = []
  let saved = (o.saved ?? {}) as never, pending = (o.pending ?? {}) as never
  const f = fixer({
    mode, perPr: o.perPr ?? 3, graceMinutes: o.grace ?? 0, now: o.now ?? (() => 0), ownerId: 1, slug: 'kage-me', allowed: id => id === 41 && (o.allowed?.() ?? true), notify: t => void told.push(t),
    seen: { load: () => saved, save: s => { saved = JSON.parse(JSON.stringify(s)) as never } },
    waiting: { load: () => pending, save: s => { pending = JSON.parse(JSON.stringify(s)) as never } },
    call: () => async (_method, path) => {
      calls.push(path)
      if (path.endsWith('/pulls')) return [{ number: 7 }]
      if (path.includes('/reviews')) return o.reviews?.() ?? [{ state: 'CHANGES_REQUESTED', user: { login: 'kim' } }]
      if (path.includes('/check-suites')) return { check_suites: (o.suites?.() ?? ['failure']).map(conclusion => ({ conclusion, app: { slug: 'ci' } })) }
      return { number: 7, title: 'Faster calls', html_url: 'https://gh/acme/app/pull/7', state: 'open', draft: false, user: { id: o.author ?? 1 }, labels: [], head: { sha: o.head?.() ?? 'abc1234def', ref: 'fix/a', repo: { full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } } }
    },
  })
  return { f, calls, told, saved: () => saved as Record<string, unknown>, pending: () => pending as Record<string, unknown> }
}

test('a failed suite on the owner\'s pull request starts one live fix, and the same commit starts no second', async () => {
  const { f, saved } = setup()
  const first = await f.handle('check_suite', failed())
  assert.equal(first.length, 1)
  first[0]!.began()
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
  for (const sha of ['aaa1111', 'bbb2222']) { head = sha; const [start] = await f.handle('check_suite', failed(sha)); start!.began() }
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
test('a listed reviewer asking for changes starts a fix that quotes the review, and an outsider starts none', async () => {
  const { f } = setup()
  const [start] = await f.handle('pull_request_review', asked)
  assert.equal(start!.headline, 'kim asked for changes on acme/app#7 Faster calls')
  assert.match(start!.content, /^> Rename it$/m)
  assert.deepEqual(await setup().f.handle('pull_request_review', { ...asked, review: { ...asked.review, author_association: 'NONE' } }), [])
})

const MIN = 60_000
test('with a wait set, a failed suite starts nothing until the wait is over, then starts one fix if the commit is still the head and still red', async () => {
  let now = 0
  const { f, pending } = setup('on', { grace: 20, now: () => now })
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  now = 5 * MIN
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(Object.keys(pending()), ['acme/app#7|abc1234def:red checks'])
  now = 19 * MIN
  assert.deepEqual(await f.due(), [])
  now = 20 * MIN
  const starts = await f.due()
  assert.deepEqual(starts.map(s => [s.live, s.thread]), [[true, 'acme/app#7']])
  starts[0]!.began()
  assert.deepEqual(pending(), {})
  assert.deepEqual(await f.due(), [])
})

test('a push during the wait, or checks that turned green on a rerun, starts nothing', async () => {
  let now = 0, head = 'abc1234def', suites = ['failure']
  const { f } = setup('on', { grace: 20, now: () => now, head: () => head, suites: () => suites })
  await f.handle('check_suite', failed())
  head = 'new5555'
  now = 20 * MIN
  assert.deepEqual(await f.due(), [])
  head = 'abc1234def'
  await f.handle('check_suite', failed())
  suites = ['success', 'skipped']
  now = 40 * MIN
  assert.deepEqual(await f.due(), [])
})

test('a pull request closed during the wait is dropped, and one waiting at a restart still gets its fix', async () => {
  let now = 0
  const first = setup('on', { grace: 20, now: () => now })
  await first.f.handle('check_suite', failed())
  const kept = first.pending()
  await first.f.handle('pull_request', closed)
  assert.deepEqual(first.pending(), {})
  now = 20 * MIN
  assert.equal((await setup('on', { grace: 20, now: () => now, pending: kept }).f.due()).length, 1)
})

test('in shadow the wait runs the same, and the fix is named only after it', async () => {
  let now = 0
  const { f, pending } = setup('shadow', { grace: 20, now: () => now })
  assert.deepEqual(await f.handle('check_suite', failed()), [])
  assert.deepEqual(pending(), {})
  now = 20 * MIN
  assert.deepEqual((await f.due()).map(s => s.live), [false])
  assert.deepEqual(pending(), {})
})

test('a fix that GitHub could not be asked about waits for the next round, and is dropped an hour after it was due', async () => {
  let now = 0, down = true
  const calls: string[] = []
  const t = setup('on', { grace: 20, now: () => now })
  await t.f.handle('check_suite', failed())
  const f2 = (await import('../github-fix.ts')).fixer({
    mode: 'on', perPr: 3, graceMinutes: 20, now: () => now, ownerId: 1, slug: 'kage-me', allowed: () => true, notify: () => {},
    seen: { load: () => ({}), save: () => {} }, waiting: { load: () => t.pending() as never, save: () => {} },
    call: () => async (_m, path) => { calls.push(path); if (down) throw new Error('GitHub down'); return {} },
  })
  now = 20 * MIN
  assert.deepEqual(await f2.due(), [])
  assert.equal(calls.length, 1)
  now = 81 * MIN
  assert.deepEqual(await f2.due(), [])
  assert.equal(calls.length, 2)
  down = false
  assert.deepEqual(await f2.due(), [])
  assert.equal(calls.length, 2)
})

test('a fix offered after its wait but never begun is offered again each round, until an hour past its wait', async () => {
  let now = 0
  const { f, pending, saved } = setup('on', { grace: 20, now: () => now })
  await f.handle('check_suite', failed())
  now = 20 * MIN
  assert.equal((await f.due()).length, 1)
  assert.equal(Object.keys(pending()).length, 1)
  now = 21 * MIN
  const again = await f.due()
  assert.equal(again.length, 1)
  again[0]!.began()
  assert.deepEqual([pending(), Object.keys(saved())], [{}, ['acme/app#7']])
  await f.handle('pull_request', closed)
  now = 30 * MIN
  await f.handle('check_suite', failed())
  now = 111 * MIN
  assert.equal((await f.due()).length, 1)
  assert.deepEqual(pending(), {})
})

test('a reviewer who approved or was dismissed during the wait starts nothing, and one who still asks does', async () => {
  let now = 0, reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'kim' } }, { state: 'APPROVED', user: { login: 'kim' } }]
  const { f } = setup('on', { grace: 20, now: () => now, reviews: () => reviews })
  await f.handle('pull_request_review', asked)
  now = 20 * MIN
  assert.deepEqual(await f.due(), [])
  reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'kim' } }, { state: 'DISMISSED', user: { login: 'kim' } }]
  await f.handle('pull_request_review', asked)
  now = 30 * MIN
  assert.deepEqual(await f.due(), [])
  reviews = [{ state: 'APPROVED', user: { login: 'ana' } }, { state: 'CHANGES_REQUESTED', user: { login: 'kim' } }, { state: 'COMMENTED', user: { login: 'kim' } }]
  await f.handle('pull_request_review', asked)
  now = 60 * MIN
  assert.equal((await f.due()).length, 1)
})

test('an installation removed during the wait starts nothing', async () => {
  let now = 0, allowed = true
  const { f, pending } = setup('on', { grace: 20, now: () => now, allowed: () => allowed })
  await f.handle('check_suite', failed())
  allowed = false
  now = 20 * MIN
  assert.deepEqual(await f.due(), [])
  assert.deepEqual(pending(), {})
})
