import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pollGithub } from '../github-poll.ts'
import { connectGithub } from '../github.ts'
import { openStore } from '../../runtime/store.ts'

const NOW = Date.parse('2026-11-22T08:00:00Z')
const API = 'https://api.github.com/repos/acme/app'
const mention = (id: string, at: string, thread = id) => ({ id, reason: 'mention', updated_at: at, repository: { full_name: 'acme/app' }, subject: { type: 'Issue', title: 'Faster calls', url: `${API}/issues/${thread}` } })
const issue = { number: 7, title: 'Faster calls', html_url: 'https://github.com/acme/app/issues/7', user: { login: 'kim' } }
const comment = (id: string, at: string) => ({ id: Number(id), body: '@ryu-dev look', user: { login: 'kim' }, author_association: 'MEMBER', html_url: `https://github.com/acme/app/issues/7#issuecomment-${id}`, created_at: at })

function github() {
  const s = { list: [] as object[], status: 200, interval: '60', failing: new Set<string>(), served: [] as number[], asked: [] as { url: string; modified?: string }[] }
  const fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    s.asked.push({ url, ...init?.headers?.['If-Modified-Since'] && { modified: init.headers['If-Modified-Since'] } })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-poll-interval': s.interval, 'last-modified': 'Sun, 22 Nov 2026 08:10:00 GMT' } })
    if (url.includes('/notifications?')) {
      if (s.status !== 200) return new Response(null, { status: s.status, headers: { 'x-poll-interval': s.interval } })
      const before = /[?&]before=([^&]+)/.exec(url)?.[1], newest = (s.list as { updated_at: string }[]).filter(n => !before || n.updated_at < decodeURIComponent(before)).reverse()
      s.served.push(newest.length)
      const r = json(newest.slice(0, 2))
      if (newest.length > 2) r.headers.set('link', '<https://api.github.com/notifications?all=true&page=2>; rel="next"')
      return r
    }
    if (s.failing.has(url)) return json({}, 502)
    const thread = /\/issues\/(\d+)(\/comments\?|$)/.exec(url)
    const n = (s.list as { id: string; updated_at: string; subject: { url: string } }[]).find(x => x.subject.url.endsWith(`/issues/${thread?.[1]}`))
    if (thread && n) return json(thread[2] ? [comment(n.id, n.updated_at)] : { ...issue, number: Number(thread[1]) })
    return json({}, 404)
  }) as typeof globalThis.fetch
  return { s, fetch }
}
function setup() {
  const gh = github(), store = openStore(':memory:'), fed: string[] = [], refusals: number[] = []
  const once = pollGithub({ token: 't', login: 'ryu-dev', saved: store, fetch: gh.fetch, refused: () => { refusals.push(1) }, feed: async (_type, _body, source) => { fed.push(source) } })
  return { ...gh, store, fed, refusals, once }
}

describe('reading GitHub notifications with no public URL', () => {
  test('the first read starts now, so nothing from before Kage was told to watch is replayed', async () => {
    const t = setup()
    t.s.list = [mention('11', '2026-11-22T06:00:00Z'), mention('12', '2026-11-22T08:00:30Z')]
    await t.once(NOW)
    assert.match(t.s.asked[0]!.url, /since=2026-11-22T07:59:00\.000Z/)
    assert.deepEqual(t.fed, ['github:c:12'])
  })

  test('the next read asks only what changed since the newest one seen, and an unchanged inbox answers 304', async () => {
    const t = setup()
    t.s.list = [mention('12', '2026-11-22T08:00:30Z')]
    await t.once(NOW)
    t.s.status = 304
    await t.once(NOW + 60_000)
    const last = t.s.asked.at(-1)!
    assert.match(last.url, /since=2026-11-22T07:59:30\.000Z/)
    assert.equal(last.modified, 'Sun, 22 Nov 2026 08:10:00 GMT')
    assert.deepEqual(t.fed, ['github:c:12'])
  })

  test('a backlog longer than one page is read to its oldest notification, as after a night asleep', async () => {
    const t = setup()
    t.s.list = ['12', '13', '14', '15', '16'].map((id, i) => mention(id, `2026-11-22T08:00:3${i}Z`))
    await t.once(NOW)
    assert.deepEqual(t.fed, ['github:c:12', 'github:c:13', 'github:c:14', 'github:c:15', 'github:c:16'])
  })

  test('it waits as long as GitHub asks, never under a minute', async () => {
    const t = setup()
    t.s.interval = '120'
    assert.equal(await t.once(NOW), 120_000)
    t.s.interval = '5'
    assert.equal(await t.once(NOW), 60_000)
  })

  test('a refused token tells the owner once, and again only after it worked in between', async () => {
    const t = setup()
    t.s.status = 401
    await t.once(NOW)
    await t.once(NOW)
    assert.equal(t.refusals.length, 1)
    t.s.status = 200
    await t.once(NOW)
    t.s.status = 401
    await t.once(NOW)
    assert.equal(t.refusals.length, 2)
  })

  test('a notification that fails to read is tried again before any later one, and skipped after three tries', async () => {
    const t = setup()
    t.s.list = [mention('12', '2026-11-22T08:00:30Z'), mention('13', '2026-11-22T08:00:40Z')]
    t.s.failing.add(`${API}/issues/12`)
    await t.once(NOW)
    await t.once(NOW)
    assert.deepEqual(t.fed, [])
    await t.once(NOW)
    assert.deepEqual(t.fed, ['github:c:13'])
  })

  test('a failing thread that keeps getting new activity is still skipped after three tries, so it never blocks the rest', async () => {
    const t = setup()
    t.s.list = [mention('12', '2026-11-22T08:00:30Z'), mention('13', '2026-11-22T08:00:40Z')]
    t.s.failing.add(`${API}/issues/12`)
    for (const at of ['2026-11-22T08:00:31Z', '2026-11-22T08:00:32Z', '2026-11-22T08:00:33Z']) { (t.s.list[0] as { updated_at: string }).updated_at = at; await t.once(NOW) }
    assert.ok(t.fed.includes('github:c:13'))
  })
})

test('in poll mode a mention opens one thread at teammate trust, and a restart does not post it again', async () => {
  const gh = github(), store = openStore(':memory:'), posts: string[] = [], tasks: boolean[] = []
  const at = new Date(Date.now() + 1000).toISOString()
  gh.s.list = [mention('12', at)]
  const start = () => connectGithub({ saved: store, via: { poll: { token: 't', fetch: gh.fetch } }, login: 'ryu-dev', botDm: 'DB', perHour: 5, notify: () => {},
    inbox: { take: (s, c, p) => store.take(s, c, p, Date.now()), handled: s => store.handled(s), has: s => store.has(s) },
    post: async text => { posts.push(text); return '100' }, deliver: (_c, task) => { tasks.push(task.fromOwner === true); return 'sent' } })
  const reads = () => gh.s.asked.filter(a => a.url.includes('/issues/12/comments?')).length
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 5)) }
  const first = start()
  await until(() => tasks.length === 1)
  first.close()
  const second = start()
  await until(() => reads() === 2)
  await new Promise(r => setTimeout(r, 20))
  second.close()
  assert.equal(reads(), 2)
  assert.equal(posts.length, 1)
  assert.match(posts[0]!, /kim mentioned you on acme\/app#12/)
  assert.deepEqual(tasks, [false])
})
