import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { jevAfk, jevCheck, jevTriage } from '../jev.ts'
import type { JevConfig } from '../../core/jev.ts'

const config: JevConfig = { key: 'apikey_secret', model: 'jev-latest', threshold: 0.5, agents: ['A0AGENT01'], url: 'https://jev.example.com/v1' }
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
    assert.equal(calls[0]!.url, config.url)
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
  const top = { hasFiles: false, inThread: false }
  const answer = (choice: string, react: number) => ({ answers: { intake: { type: 'choice', choice, confidence: 1, probabilities: { session: 1 - react, react } } } })
  const run = (f: typeof fetch, o: { timeoutMs?: number } = {}) => {
    const events: string[] = []
    return { events, triage: jevTriage(config, (who, d) => events.push(`${who} ${d}`), { fetch: f, ...o }) }
  }
  test('a thanks from a teammate gets a reaction, and the event holds the pick and score but not the text', async () => {
    const { f, calls } = answering(200, answer('react', 0.97))
    const { triage, events } = run(f)
    const v = await triage('C1:5.5', 'other', 'thanks, that works', top)
    assert.equal(v.pick, 'react')
    assert.equal(calls[0]!.url, config.url)
    assert.equal(JSON.parse(String(calls[0]!.init.body)).questions.intake.type, 'choice')
    assert.deepEqual(events, ['C1:5.5 react: other react 0.97, reaction eyes 0.00'])
    assert.ok(!events.join().includes('thanks') && !events.join().includes('apikey_secret'))
  })
  test('a request gets a session', async () => {
    const { triage, events } = run(answering(200, answer('session', 0.02)).f)
    assert.equal((await triage('C1:5.5', 'other', 'deploy the fix', top)).pick, 'session')
    assert.match(events[0]!, /session: other react 0.02/)
  })
  test('conversation context reaches both questions, and work wins over an emoji pick', async () => {
    const body = answer('session', 0.01) as any
    body.answers.reaction = { choice: 'fire', confidence: 1 }
    const { f, calls } = answering(200, body)
    const v = await run(f).triage('CTEST:1', 'other', 'ship it', { ...top, context: async () => 'The build is ready.' })
    assert.equal(v.pick, 'session')
    assert.equal(v.reaction?.emoji, 'fire')
    const request = JSON.parse(String(calls[0]!.init.body))
    assert.match(request.state, /The build is ready/)
    assert.deepEqual(Object.keys(request.questions).sort(), ['intake', 'reaction'])
    assert.equal(calls.length, 1)
  })
  test('an unavailable conversation starts a session, and skips never fetch context', async () => {
    const { f, calls } = answering(200, answer('react', 1))
    let contexts = 0
    const context = async () => { contexts++; throw new Error('Slack is down') }
    const { triage } = run(f)
    assert.equal((await triage('CTEST:1', 'other', 'thanks', { ...top, context })).pick, 'session')
    assert.equal((await triage('CTEST:1', 'other', 'thanks', { ...top, inThread: true, context })).pick, 'session')
    assert.equal(contexts, 1)
    assert.equal(calls.length, 0)
  })
  test('the owner\'s message needs a stricter bar than a teammate\'s', async () => {
    const f = answering(200, answer('react', 0.9)).f
    assert.equal((await run(f).triage('C1:1.1', 'other', 'ok', top)).pick, 'react')
    assert.equal((await run(f).triage('C1:1.1', 'owner', 'ok', top)).pick, 'session')
  })
  test('a reply in a thread starts a session with no Jev call', async () => {
    const { f, calls } = answering(200, answer('react', 0.99))
    const v = await run(f).triage('C1:5.5', 'owner', 'ok do it', { hasFiles: false, inThread: true })
    assert.equal(v.pick, 'session')
    assert.equal(calls.length, 0)
  })
  test('a question, a long message or files start a session with no call', async () => {
    const { f, calls } = answering(200, answer('react', 1))
    const { triage } = run(f)
    for (const [t, hasFiles] of [['can you look?', false], ['x'.repeat(500), false], ['ok', true]] as const) assert.equal((await triage(`C1:${t.length}`, 'other', t, { hasFiles, inThread: false })).pick, 'session')
    assert.equal(calls.length, 0)
  })
  test('it fails open: HTTP error, unreadable answer, ignore, network error and timeout all give a session', async () => {
    for (const f of [answering(500, {}).f, answering(200, { answers: {} }).f, answering(200, answer('ignore', 1)).f, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch]) {
      const { triage, events } = run(f)
      assert.equal((await triage('C1:5.5', 'other', 'ok', top)).pick, 'session')
      assert.equal(events.length, 1)
    }
    const slow = ((_: string, init: RequestInit) => new Promise((_r, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const alive = setTimeout(() => {}, 1000)
    const { triage, events } = run(slow, { timeoutMs: 20 })
    const v = await triage('C1:5.5', 'other', 'ok', top)
    clearTimeout(alive)
    assert.equal(v.pick, 'session')
    assert.match(events[0]!, /TimeoutError/)
  })
})

describe('AFK triage with Jev', () => {
  const ok = { answers: { urgency: { type: 'choice', choice: 'high', confidence: 1, probabilities: { high: 0.9 } }, waits: { type: 'noul', noul: 0.9 }, lookup: { type: 'noul', noul: 0.1 } } }
  const input = { owner: 'Sam', place: '#eng', from: 'Maya', convo: 'Maya: the build is red' }
  test('it returns urgency, waits and lookup, and sends the key in the header only', async () => {
    const { f, calls } = answering(200, ok)
    assert.deepEqual(await jevAfk(config, { fetch: f })(input), { urgency: 'high', waits: true, lookup: false })
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer apikey_secret')
    assert.ok(!String(calls[0]!.init.body).includes('apikey_secret'))
  })
  test('an error, a bad answer or a timeout gives undefined, so the Claude triage runs instead', async () => {
    assert.equal(await jevAfk(config, { fetch: answering(500, {}).f })(input), undefined)
    assert.equal(await jevAfk(config, { fetch: answering(200, { answers: {} }).f })(input), undefined)
    const slow = ((_: string, init: RequestInit) => new Promise((_r, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const alive = setTimeout(() => {}, 1000)
    assert.equal(await jevAfk(config, { fetch: slow, timeoutMs: 20 })(input), undefined)
    clearTimeout(alive)
  })
})
