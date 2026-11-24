import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { slackHttp } from '../http.ts'

const SECRET = 'signing-test-secret'
const EVENT = { type: 'event_callback', event_id: 'Ev0TEST1', event: { type: 'message', channel: 'C0TEST1', ts: '5.5', user: 'U0TEST1', text: 'hi' } }

async function startReceiver() {
  const receiver = slackHttp({ secret: SECRET, port: 0 })
  const port = await receiver.start()
  return { receiver, url: `http://127.0.0.1:${port}/slack` }
}

function signedPost(url: string, body: string, o: { type?: string; secret?: string; stamp?: number; retry?: number } = {}) {
  const stamp = String(o.stamp ?? Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac('sha256', o.secret ?? SECRET).update(`v0:${stamp}:${body}`).digest('hex')}`
  return fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(2_500), headers: {
    'content-type': o.type ?? 'application/json', 'x-slack-request-timestamp': stamp, 'x-slack-signature': signature, ...(o.retry && { 'x-slack-retry-num': String(o.retry) }),
  } })
}

describe('the Slack HTTP route', () => {
  test('a request signed with the signing secret reaches the listener for its event, as Socket Mode would hand it, and is answered 200', async () => {
    const { receiver, url } = await startReceiver()
    const heard: unknown[] = []
    receiver.on('message', async ({ event, body, ack }) => { heard.push({ event, body }); await ack() })
    try {
      const r = await signedPost(url, JSON.stringify(EVENT))
      assert.equal(r.status, 200)
      assert.deepEqual(heard, [{ event: EVENT.event, body: EVENT }])
    } finally { receiver.close() }
  })

  test('a bad signature, another secret or none, gets 401 and reaches no listener', async () => {
    const { receiver, url } = await startReceiver()
    let heard = 0
    receiver.on('message', async ({ ack }) => { heard++; await ack() })
    try {
      assert.equal((await signedPost(url, JSON.stringify(EVENT), { secret: 'other-secret' })).status, 401)
      assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(EVENT), headers: { 'content-type': 'application/json' } })).status, 401)
      assert.equal(heard, 0)
    } finally { receiver.close() }
  })

  test('a request whose timestamp is more than 5 minutes old is refused even with a good signature', async () => {
    const { receiver, url } = await startReceiver()
    let heard = 0
    receiver.on('message', async ({ ack }) => { heard++; await ack() })
    try {
      assert.equal((await signedPost(url, JSON.stringify(EVENT), { stamp: Math.floor(Date.now() / 1000) - 301 })).status, 401)
      assert.equal(heard, 0)
    } finally { receiver.close() }
  })

  test('a signed url_verification is answered with its challenge', async () => {
    const { receiver, url } = await startReceiver()
    try {
      const r = await signedPost(url, JSON.stringify({ type: 'url_verification', token: 'x', challenge: 'c-test-1' }))
      assert.equal(r.status, 200)
      assert.equal(await r.text(), 'c-test-1')
    } finally { receiver.close() }
  })

  test('only POST on /slack answers, and a signed body that means nothing is 400', async () => {
    const { receiver, url } = await startReceiver()
    try {
      assert.equal((await fetch(url)).status, 404)
      assert.equal((await fetch(url.replace('/slack', '/other'), { method: 'POST', body: '{}' })).status, 404)
      assert.equal((await signedPost(url, '{"type":"something_else"}')).status, 400)
    } finally { receiver.close() }
  })

  test('the 200 goes out at the ack, before the work after it ends, so Slack never waits 3 seconds on a task', async () => {
    const { receiver, url } = await startReceiver()
    let release = () => {}
    const working = new Promise<void>(done => { release = done })
    let acked = false
    receiver.on('message', async ({ ack }) => { await ack(); acked = true; await working })
    try {
      const r = await signedPost(url, JSON.stringify(EVENT))
      assert.equal(r.status, 200)
      assert.equal(acked, true)
    } finally { release(); receiver.close() }
  })

  test('a listener that fails before its ack gets 500, so Slack sends the event again', async () => {
    const { receiver, url } = await startReceiver()
    const original = console.error
    console.error = () => {}
    receiver.on('message', async () => { throw new Error('disk full') })
    try {
      assert.equal((await signedPost(url, JSON.stringify(EVENT))).status, 500)
    } finally { console.error = original; receiver.close() }
  })

  test('an event no listener takes is answered 200, and a listener that never acks still gets its 200 when it ends', async () => {
    const { receiver, url } = await startReceiver()
    let ended = 0
    receiver.on('message', async () => { ended++ })
    try {
      assert.equal((await signedPost(url, JSON.stringify({ ...EVENT, event: { type: 'reaction_added' } }))).status, 200)
      assert.equal((await signedPost(url, JSON.stringify(EVENT))).status, 200)
      assert.equal(ended, 1)
    } finally { receiver.close() }
  })

  test('the ack of a slash command is the JSON body of the 200', async () => {
    const { receiver, url } = await startReceiver()
    receiver.on('slash_commands', async ({ ack }) => { await ack({ response_type: 'ephemeral', text: 'not set up' }) })
    try {
      const r = await signedPost(url, new URLSearchParams({ command: '/x', team_id: 'T0TEST1' }).toString(), { type: 'application/x-www-form-urlencoded' })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'application/json')
      assert.deepEqual(await r.json(), { response_type: 'ephemeral', text: 'not set up' })
    } finally { receiver.close() }
  })

  test('the signature covers the raw bytes Slack sent, spaces and escaped slashes included', async () => {
    const { receiver, url } = await startReceiver()
    const heard: unknown[] = []
    receiver.on('message', async ({ event, ack }) => { heard.push(event); await ack() })
    const raw = '{ "type": "event_callback", "event_id": "Ev0TEST2", "event": { "type": "message", "text": "a\\/b é" } }'
    try {
      assert.equal((await signedPost(url, raw)).status, 200)
      assert.deepEqual(heard, [{ type: 'message', text: 'a/b é' }])
    } finally { receiver.close() }
  })

  test('a body over 1 MB is cut before its signature is checked and reaches no listener', async () => {
    const { receiver, url } = await startReceiver()
    let heard = 0
    receiver.on('message', async ({ ack }) => { heard++; await ack() })
    const huge = JSON.stringify({ ...EVENT, event: { ...EVENT.event, text: 'x'.repeat(1_000_001) } })
    try {
      const status = await signedPost(url, huge).then(r => r.status, () => 'cut')
      assert.ok(status === 413 || status === 'cut', `got ${status}`)
      assert.equal(heard, 0)
    } finally { receiver.close() }
  })

  test('a stale timestamp is refused before the body is read, so a slow body cannot hold the route', async () => {
    const { receiver, url } = await startReceiver()
    const stale = String(Math.floor(Date.now() / 1000) - 301)
    try {
      const status = await new Promise<number>((done, fail) => {
        const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100', 'x-slack-request-timestamp': stale, 'x-slack-signature': 'v0=00' } })
        const timer = setTimeout(() => { req.destroy(); fail(new Error('no answer while the body was still open')) }, 1_500)
        req.on('response', r => { clearTimeout(timer); req.destroy(); done(r.statusCode ?? 0) })
        req.on('error', () => {})
        req.write('{')
      })
      assert.equal(status, 401)
    } finally { receiver.close() }
  })

  test('a signed ssl_check and an app_rate_limited notice get 200 and reach no listener, so Slack does not count a failure', async () => {
    const { receiver, url } = await startReceiver()
    let heard = 0
    receiver.on('slash_commands', async ({ ack }) => { heard++; await ack() })
    try {
      assert.equal((await signedPost(url, new URLSearchParams({ ssl_check: '1', token: 'x' }).toString(), { type: 'application/x-www-form-urlencoded' })).status, 200)
      assert.equal((await signedPost(url, JSON.stringify({ type: 'app_rate_limited', team_id: 'T0TEST1', minute_rate_limited: 1 }))).status, 200)
      assert.equal(heard, 0)
    } finally { receiver.close() }
  })

  test('start tells its connected listeners once it listens, so catch-up runs at hub start', async () => {
    const receiver = slackHttp({ secret: SECRET, port: 0 })
    let connected = 0
    receiver.on('connected', () => { connected++ })
    try {
      await receiver.start()
      assert.equal(connected, 1)
    } finally { receiver.close() }
  })
})
