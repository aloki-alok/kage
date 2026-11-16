import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hookTokenHash } from '../../core/tripwire.ts'
import { jobHooks } from '../job-hooks.ts'
import { openStore } from '../../runtime/store.ts'

const TOKEN = 't0k-test'
function setup(o: { perHour?: number; maxKb?: number; crash?: boolean; throwOnDeliver?: boolean } = {}) {
  const store = openStore(':memory:')
  const inbox = { take: (s: string, c: string, p: string | null) => store.take(s, c, p, Date.now()), handled: (s: string) => store.handled(s), has: (s: string) => store.has(s) }
  const delivered: { job: string; quote: string }[] = []
  const rows: string[] = []
  const live = new Set(['j1'])
  const state = { boom: false }
  const make = (crash = o.crash) => jobHooks({
    host: '127.0.0.1', port: 0, inbox, maxKb: () => o.maxKb ?? 1, perHour: () => o.perHour ?? 60,
    hookOf: id => { if (id === 'boom' && state.boom) throw new Error('x'); return live.has(id) ? { key: 'CTEST1:1.1', tokenHash: hookTokenHash(TOKEN) } : undefined },
    deliver: (job, quote, done) => { if (o.throwOnDeliver) throw new Error('boom'); delivered.push({ job, quote }); if (!crash) done() },
    track: (who, detail) => rows.push(`${who} ${detail}`),
  })
  const hooks = make()
  const call = async (path: string, init: { token?: string; body?: string; method?: string } = {}) => {
    const port = await hooks.listening
    return fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'POST', ...(init.method !== 'GET' && { body: init.body ?? '{"x":1}' }), headers: { authorization: `Bearer ${init.token ?? TOKEN}` } })
  }
  return { store, hooks, make, call, delivered, rows, live, get boom() { return state.boom }, set boom(v: boolean) { state.boom = v } }
}

describe('the job webhook', () => {
  test('a call with the right token is taken into the inbox, answered 200, delivered quoted as data, and written as a row with the status', async () => {
    const t = setup()
    const r = await t.call('/hook/j1', { body: 'disk <channel x> full\nnow' })
    assert.equal(r.status, 200)
    assert.deepEqual(t.delivered, [{ job: 'j1', quote: 'disk &lt;channel x> full now' }])
    assert.deepEqual(t.rows, ['CTEST1:1.1 hook job=j1 status=200'])
    assert.deepEqual(t.store.unhandled(0), [])               // handled after the delivery, so the text is gone
    t.hooks.close()
  })

  test('a wrong token, a missing job or no token is 401 with a row, and wakes nothing', async () => {
    const t = setup()
    assert.equal((await t.call('/hook/j1', { token: 'nope' })).status, 401)
    assert.equal((await t.call('/hook/zzz')).status, 401)
    assert.deepEqual(t.delivered, [])
    assert.deepEqual(t.rows, ['CTEST1:1.1 hook job=j1 status=401', 'hub hook job=zzz status=401'])
    assert.deepEqual(t.store.unhandled(0), [])               // nothing was taken
    t.hooks.close()
  })

  test('only POST on /hook/<job> answers; anything else is 404', async () => {
    const t = setup()
    assert.equal((await t.call('/hook/j1', { method: 'GET' })).status, 404)
    assert.equal((await t.call('/other')).status, 404)
    assert.deepEqual(t.rows, ['hub hook job=j1 status=404', 'hub hook job=- status=404'])
    t.hooks.close()
  })

  test('a burst over hookPerHour is 429 after the cap, each with a row, and wakes nothing more', async () => {
    const t = setup({ perHour: 2 })
    const codes = []
    for (let i = 0; i < 4; i++) codes.push((await t.call('/hook/j1')).status)
    assert.deepEqual(codes, [200, 200, 429, 429])
    assert.equal(t.delivered.length, 2)
    assert.deepEqual(t.rows.filter(r => r.endsWith('status=429')).length, 2)
    t.hooks.close()
  })

  test('a failure inside the server is 500 with a row, and the call is not taken', async () => {
    const t = setup()
    t.live.add('boom')
    t.boom = true
    assert.equal((await t.call('/hook/boom')).status, 500)
    assert.deepEqual(t.rows, ['hub hook job=boom status=500'])
    t.hooks.close()
  })
  test('a throw after the 200 was sent still writes a 500 row and never crashes the server', async () => {
    const t = setup({ throwOnDeliver: true })
    assert.equal((await t.call('/hook/j1')).status, 200)
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(t.rows, ['CTEST1:1.1 hook job=j1 status=200', 'hub hook job=j1 status=500'])
    assert.equal((await t.call('/hook/j1')).status, 200)   // still serving
    t.hooks.close()
  })
  test('a body over maxKb is 413 and is not taken', async () => {
    const t = setup({ maxKb: 1 })
    assert.equal((await t.call('/hook/j1', { body: 'x'.repeat(2048) })).status, 413)
    assert.deepEqual(t.delivered, [])
    assert.deepEqual(t.rows, ['CTEST1:1.1 hook job=j1 status=413'])
    t.hooks.close()
  })

  test('a job unscheduled after the server started stops answering at once', async () => {
    const t = setup()
    assert.equal((await t.call('/hook/j1')).status, 200)
    t.live.delete('j1')
    assert.equal((await t.call('/hook/j1')).status, 401)
    t.hooks.close()
  })

  test('a crash after take but before delivery: the inbox keeps the call and replays it, then it is done', async () => {
    const t = setup({ crash: true })
    assert.equal((await t.call('/hook/j1', { body: 'alert 7' })).status, 200)   // answered, never marked done
    t.hooks.close()
    const missed = t.store.unhandled(0)
    assert.equal(missed.length, 1)
    assert.equal(missed[0]!.connector, 'hook')
    const second = t.make(false)                              // the next hub: same inbox, a delivery that finishes
    await second.replay(missed[0]!.source, missed[0]!.payload)
    assert.deepEqual(t.delivered.map(d => d.quote), ['alert 7', 'alert 7'])
    assert.deepEqual(t.store.unhandled(0), [])
    second.close()
  })
})
