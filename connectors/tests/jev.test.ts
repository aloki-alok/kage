import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { jevCheck, jevTriage } from '../jev.ts'
import { JEV_URL, type JevConfig } from '../../core/jev.ts'

const config: JevConfig = { key: 'apikey_secret', model: 'jev-latest', threshold: 0.5, agents: ['A0AGENT01'] }
const answering = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('asking Jev about an agent post', () => {
  test('an ack scores low and starts nothing; the key goes in the header only', async () => {
    const { f, calls } = answering(200, { answers: { needs_reply: { type: 'noul', noul: 0.04 } } })
    const v = await jevCheck(config, { fetch: f })('A0AGENT01', 'Done, thanks!')
    assert.equal(v.reply, false)
    assert.match(v.why, /needs_reply 0\.04/)
    assert.equal(calls[0]!.url, JEV_URL)
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer apikey_secret')
    assert.ok(!String(calls[0]!.init.body).includes('apikey_secret'))
    assert.ok(!v.why.includes('apikey_secret') && !v.why.includes('Done, thanks'))
  })
  test('a request scores high and starts a task', async () => {
    const { f } = answering(200, { answers: { needs_reply: { type: 'noul', noul: 0.98 } } })
    assert.equal((await jevCheck(config, { fetch: f })('A0AGENT01', 'Can you check campaign 42?')).reply, true)
  })
  test('an agent Jev does not check is answered without a call', async () => {
    const { f, calls } = answering(200, {})
    const v = await jevCheck(config, { fetch: f })('A0OTHER01', 'Done')
    assert.equal(v.reply, true)
    assert.equal(calls.length, 0)
  })
  test('it fails open: an HTTP error, an unreadable answer, a network error or a timeout all answer the post', async () => {
    assert.equal((await jevCheck(config, { fetch: answering(401, { detail: 'bad key' }).f })('A0AGENT01', 'x')).reply, true)
    assert.equal((await jevCheck(config, { fetch: answering(200, { answers: {} }).f })('A0AGENT01', 'x')).reply, true)
    const broken = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    assert.equal((await jevCheck(config, { fetch: broken })('A0AGENT01', 'x')).reply, true)
    const slow = ((_: string, init: RequestInit) => new Promise((_r, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    // AbortSignal.timeout's timer does not hold the event loop, and this fake fetch holds no socket: keep Node up.
    const alive = setTimeout(() => {}, 1000)
    const v = await jevCheck(config, { fetch: slow, timeoutMs: 20 })('A0AGENT01', 'x')
    clearTimeout(alive)
    assert.equal(v.reply, true)
    assert.match(v.why, /TimeoutError/)
  })
})

describe('intake triage of a tagged message', () => {
  const answer = (choice: string, react: number) => ({ answers: { intake: { type: 'choice', choice, confidence: 1, probabilities: { session: 1 - react, react } } } })
  const run = (f: typeof fetch, o: { timeoutMs?: number } = {}) => {
    const events: string[] = []
    return { events, triage: jevTriage(config, (who, d) => events.push(`${who} ${d}`), { fetch: f, ...o }) }
  }
  test('a thanks from a teammate gets a reaction, and the event holds the pick and score but not the text', async () => {
    const { f, calls } = answering(200, answer('react', 0.97))
    const { triage, events } = run(f)
    const v = await triage('C1:5.5', 'other', 'thanks, that works', false)
    assert.equal(v.pick, 'react')
    assert.equal(calls[0]!.url, JEV_URL)
    assert.equal(JSON.parse(String(calls[0]!.init.body)).questions.intake.type, 'choice')
    assert.deepEqual(events, ['C1:5.5 react: other react 0.97'])
    assert.ok(!events.join().includes('thanks') && !events.join().includes('apikey_secret'))
  })
  test('a request gets a session', async () => {
    const { triage, events } = run(answering(200, answer('session', 0.02)).f)
    assert.equal((await triage('C1:5.5', 'other', 'deploy the fix', false)).pick, 'session')
    assert.match(events[0]!, /session: other react 0.02/)
  })
  test('the owner\'s message needs a stricter bar than a teammate\'s', async () => {
    const f = answering(200, answer('react', 0.9)).f
    assert.equal((await run(f).triage('C1:1.1', 'other', 'ok', false)).pick, 'react')
    assert.equal((await run(f).triage('C1:1.1', 'owner', 'ok', false)).pick, 'session')
  })
  test('a re-tag in a thread that got a reaction always starts a session, with no Jev call', async () => {
    const { f, calls } = answering(200, answer('react', 0.99))
    const { triage } = run(f)
    assert.equal((await triage('C1:5.5', 'owner', 'ok', false)).pick, 'react')
    assert.equal((await triage('C1:5.5', 'owner', 'ok do it', false)).pick, 'session')
    assert.equal(calls.length, 1)
  })
  test('a question, a long message or files start a session with no call', async () => {
    const { f, calls } = answering(200, answer('react', 1))
    const { triage } = run(f)
    for (const [t, files] of [['can you look?', false], ['x'.repeat(500), false], ['ok', true]] as const) assert.equal((await triage(`C1:${t.length}`, 'other', t, files)).pick, 'session')
    assert.equal(calls.length, 0)
  })
  test('it fails open: HTTP error, unreadable answer, ignore, network error and timeout all give a session', async () => {
    for (const f of [answering(500, {}).f, answering(200, { answers: {} }).f, answering(200, answer('ignore', 1)).f, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch]) {
      const { triage, events } = run(f)
      assert.equal((await triage('C1:5.5', 'other', 'ok', false)).pick, 'session')
      assert.equal(events.length, 1)
    }
    const slow = ((_: string, init: RequestInit) => new Promise((_r, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const alive = setTimeout(() => {}, 1000)
    const { triage, events } = run(slow, { timeoutMs: 20 })
    const v = await triage('C1:5.5', 'other', 'ok', false)
    clearTimeout(alive)
    assert.equal(v.pick, 'session')
    assert.match(events[0]!, /TimeoutError/)
  })
})
