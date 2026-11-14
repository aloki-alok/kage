import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { jevCheck } from '../jev.ts'
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
    const v = await jevCheck(config, { fetch: slow, timeoutMs: 20 })('A0AGENT01', 'x')
    assert.equal(v.reply, true)
    assert.match(v.why, /TimeoutError/)
  })
})
