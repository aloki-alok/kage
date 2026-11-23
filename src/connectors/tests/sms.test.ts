import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { connectSms } from '../sms.ts'
import type { SmsSent } from '../sms-send.ts'
import { openSmsStore } from '../../runtime/sms-store.ts'
import { openStore } from '../../runtime/store.ts'

const OURS = '+14155550199', A = '+14155550101', B = '+14155550102', C = '+14155550103'
const URL_ = 'https://kage.example.test/sms'
const TOKEN = 'twilio-fake'
const IN_WINDOW = new Date('2026-11-23T20:00:00Z'), NIGHT = new Date('2026-11-23T04:00:00Z')
const telnyxKeys = generateKeyPairSync('ed25519')
const telnyxPublic = telnyxKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')

type Answer = SmsSent | 'throw' | undefined
async function setup(o: { provider?: 'twilio' | 'telnyx'; perHour?: number; perMinute?: number; answer?: (to: string) => Answer | Promise<Answer>; postFails?: () => boolean; postHangs?: () => boolean } = {}) {
  const store = openSmsStore(':memory:', () => '2026-11-23T20:00:00.000Z')
  const kv = openStore(':memory:')
  const sent: { to: string; body: string }[] = [], tasks: { key: string; content: string; outsider?: string; source?: string }[] = []
  const told: string[] = [], posts: { thread: string; text: string }[] = []
  let n = 0, now = IN_WINDOW
  const sms = connectSms({
    provider: o.provider ?? 'twilio', from: OURS, port: 0, publicUrl: URL_, perHour: o.perHour ?? 10, perMinute: o.perMinute ?? 2, tickMs: 0,
    twilioAuthToken: TOKEN, telnyxPublicKey: telnyxPublic, clock: () => now,
    send: async (to, _from, body) => {
      const a = await o.answer?.(to)
      if (a === 'throw') throw new Error('network down')
      sent.push({ to, body })
      return a ?? { id: `SM0TEST${++n}` }
    },
    store, inbox: { take: (s, c, p) => kv.take(s, c, p, Date.now()), handled: s => kv.handled(s), has: s => kv.has(s) },
    deliver: (c, task) => { tasks.push({ key: `${c.connector}:${c.chat}`, content: task.content, ...(task.outsider && { outsider: task.outsider }), ...(task.source && { source: task.source }) }); return 'sent' },
    notify: t => void told.push(t),
    post: async (thread, text) => { if (o.postHangs?.()) return new Promise<boolean>(() => {}); if (o.postFails?.()) return false; posts.push({ thread, text }); return true },
  })
  const port = await sms.listening
  const twilio = (params: Record<string, string>, sig?: string) => {
    const signed = URL_ + Object.keys(params).sort().map(k => k + params[k]).join('')
    return fetch(`http://127.0.0.1:${port}/sms`, { method: 'POST', body: new URLSearchParams(params).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? createHmac('sha1', TOKEN).update(signed).digest('base64') } })
  }
  const telnyx = (body: unknown, at = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(body)
    return fetch(`http://127.0.0.1:${port}/sms`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'telnyx-timestamp': String(at),
      'telnyx-signature-ed25519': sign(null, Buffer.from(`${at}|${raw}`), telnyxKeys.privateKey).toString('base64') } })
  }
  const events = (body: unknown, o: { sig?: string; hash?: string | null; path?: string } = {}) => {
    const raw = JSON.stringify(body)
    const hash = o.hash === undefined ? createHash('sha256').update(raw).digest('hex') : o.hash
    const query = hash === null ? '' : `?bodySHA256=${hash}`
    const path = o.path ?? '/sms/events'
    return fetch(`http://127.0.0.1:${port}${path}${query}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json',
      'x-twilio-signature': o.sig ?? createHmac('sha1', TOKEN).update(`${URL_}${path.slice('/sms'.length)}${query}`).digest('base64') } })
  }
  const campaign = (phones = [A, B, C]) => {
    const { id } = store.createCampaign({ name: 'promo', body: 'Sale ends Friday. Reply STOP to opt out.', thread: 'D0TEST1:1.1', phones })
    store.move(id, 'launch')
    return id
  }
  return { sms, store, sent, tasks, told, posts, twilio, telnyx, events, campaign, setNow: (d: Date) => { now = d } }
}
type Setup = Awaited<ReturnType<typeof setup>>
const text = (MessageSid: string, Body: string, From = A) => ({ MessageSid, SmsStatus: 'received', From, To: OURS, Body })

describe('a text that comes in', () => {
  test('a signed Twilio text becomes a task for a stranger, tied to the campaign that texted them, and Twilio gets empty TwiML', async () => {
    const t = await setup()
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      const r = await t.twilio(text('SM0IN1', 'what time do you open?'))
      assert.equal(r.status, 200)
      assert.equal(await r.text(), '<Response></Response>')
      assert.equal(t.tasks.length, 1)
      assert.equal(t.tasks[0]!.key, `sms:${t.store.person(A)}`)
      assert.ok(t.tasks[0]!.outsider)
      assert.equal(t.tasks[0]!.source, 'sms:SM0IN1')
      assert.match(t.tasks[0]!.content, /what time do you open/)
      assert.match(t.tasks[0]!.content, /promo/)
      assert.equal(t.store.report(id)!.replies, 1)
    } finally { t.sms.close() }
  })
  test('a bad signature is refused and stores nothing', async () => {
    const t = await setup()
    try {
      assert.equal((await t.twilio(text('SM0IN2', 'hi'), 'AAAA')).status, 401)
      assert.equal(t.tasks.length, 0)
      assert.equal(t.store.heard(A, 'SM0IN2').fresh, true)
    } finally { t.sms.close() }
  })
  test('the same text delivered twice starts one task', async () => {
    const t = await setup()
    try {
      await t.twilio(text('SM0IN3', 'hello'))
      await t.twilio(text('SM0IN3', 'hello'))
      assert.equal(t.tasks.length, 1)
    } finally { t.sms.close() }
  })
  test('STOP opts the number out and starts no task, and the next campaign skips it', async () => {
    const t = await setup()
    try {
      await t.twilio(text('SM0IN4', 'stop'))
      assert.equal(t.tasks.length, 0)
      t.campaign([A, B])
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [B])
    } finally { t.sms.close() }
  })
  test('a text to a number that is not ours is ignored', async () => {
    const t = await setup()
    try {
      await t.twilio({ ...text('SM0IN5', 'hi'), To: '+14155550000' })
      assert.equal(t.tasks.length, 0)
    } finally { t.sms.close() }
  })
  test('over the hourly cap, texts are stored but start no task, and the owner hears once', async () => {
    const t = await setup({ perHour: 1 })
    try {
      await t.twilio(text('SM0IN6', 'one', A))
      await t.twilio(text('SM0IN7', 'two', B))
      await t.twilio(text('SM0IN8', 'three', C))
      assert.equal(t.tasks.length, 1)
      assert.equal(t.told.length, 1)
      assert.equal(t.store.heard(C, 'SM0IN8').fresh, false)
    } finally { t.sms.close() }
  })
  test('a signed Telnyx text and a Telnyx status both land, and an old signature is refused', async () => {
    const t = await setup({ provider: 'telnyx' })
    try {
      const inbound = { data: { event_type: 'message.received', payload: { id: 'msg-in-1', from: { phone_number: A }, to: [{ phone_number: OURS }], text: 'hi' } } }
      assert.equal((await t.telnyx(inbound)).status, 200)
      assert.equal(t.tasks.length, 1)
      assert.equal((await t.telnyx(inbound, Math.floor(Date.now() / 1000) - 600)).status, 401)
      const id = t.campaign([B])
      await t.sms.tick()
      await t.telnyx({ data: { event_type: 'message.finalized', payload: { id: 'SM0TEST1', to: [{ status: 'delivered' }] } } })
      assert.equal(t.store.report(id)!.counts.delivered, 1)
    } finally { t.sms.close() }
  })
})

describe('a text that comes in through Twilio Event Streams', () => {
  const received = (messageSid: string, body: string, to = OURS) => ({ type: 'com.twilio.messaging.inbound-message.received', data: { messageSid, from: A, to, body } })
  test('a signed batch starts one task per text to our number, and texts to other numbers on the account are dropped', async () => {
    const t = await setup()
    try {
      const r = await t.events([received('SM0EV1', 'are you open?'), received('SM0EV2', 'not for you', '+14155550000')])
      assert.equal(r.status, 200)
      assert.equal(t.tasks.length, 1)
      assert.equal(t.tasks[0]!.source, 'sms:SM0EV1')
      assert.match(t.tasks[0]!.content, /are you open/)
    } finally { t.sms.close() }
  })
  test('a bad signature, a body hash that does not match, or no body hash is refused and starts nothing', async () => {
    const t = await setup()
    try {
      assert.equal((await t.events([received('SM0EV3', 'hi')], { sig: 'AAAA' })).status, 401)
      assert.equal((await t.events([received('SM0EV3', 'hi')], { hash: '0'.repeat(64) })).status, 401)
      assert.equal((await t.events([received('SM0EV3', 'hi')], { hash: null })).status, 401)
      assert.equal(t.tasks.length, 0)
    } finally { t.sms.close() }
  })
  test('the same text through the form webhook and through Event Streams starts one task', async () => {
    const t = await setup()
    try {
      await t.twilio(text('SM0EV4', 'hello'))
      await t.events([received('SM0EV4', 'hello')])
      await t.events([received('SM0EV4', 'hello')])
      assert.equal(t.tasks.length, 1)
    } finally { t.sms.close() }
  })
  test('a signed post to a path that only starts with the Event Streams path gets 404', async () => {
    const t = await setup()
    try {
      assert.equal((await t.events([received('SM0EV6', 'hi')], { path: '/sms/events/x' })).status, 404)
      assert.equal((await t.events([received('SM0EV6', 'hi')], { path: '/sms/eventsX' })).status, 404)
      assert.equal(t.tasks.length, 0)
    } finally { t.sms.close() }
  })
  test('a Telnyx install has no Event Streams route', async () => {
    const t = await setup({ provider: 'telnyx' })
    try {
      assert.equal((await t.events([received('SM0EV5', 'hi')])).status, 404)
      assert.equal(t.tasks.length, 0)
    } finally { t.sms.close() }
  })
})

describe('sending a campaign', () => {
  test('a tick sends nothing outside 2pm to 8pm Eastern', async () => {
    const t = await setup()
    try {
      t.campaign()
      t.setNow(NIGHT)
      await t.sms.tick()
      assert.equal(t.sent.length, 0)
    } finally { t.sms.close() }
  })
  test('a tick sends at most perMinute texts, and the next tick goes on', async () => {
    const t = await setup({ perMinute: 2 })
    try {
      t.campaign()
      await t.sms.tick()
      assert.equal(t.sent.length, 2)
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A, B, C])
    } finally { t.sms.close() }
  })
  test('two ticks at once still text each number once', async () => {
    const t = await setup({ perMinute: 5 })
    try {
      t.campaign()
      await Promise.all([t.sms.tick(), t.sms.tick()])
      assert.equal(t.sent.length, 3)
    } finally { t.sms.close() }
  })
  test('a status callback updates the message, and a done campaign posts its report to its thread once', async () => {
    const t = await setup({ perMinute: 5 })
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      await t.twilio({ MessageSid: 'SM0TEST1', MessageStatus: 'delivered' })
      await t.sms.tick()
      await t.sms.tick()
      assert.equal(t.store.report(id)!.counts.delivered, 1)
      assert.equal(t.posts.length, 1)
      assert.equal(t.posts[0]!.thread, 'D0TEST1:1.1')
      assert.match(t.posts[0]!.text, /promo: done/)
    } finally { t.sms.close() }
  })
  test('a network error marks that text failed and never sends it again', async () => {
    const t = await setup({ perMinute: 5, answer: to => (to === A ? 'throw' : { id: `SM0TEST${to.slice(-1)}` }) })
    try {
      const id = t.campaign()
      await t.sms.tick()
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [B, C])
      assert.equal(t.store.report(id)!.errors.network, 1)
    } finally { t.sms.close() }
  })
  test('refused credentials pause the campaign and tell the owner once', async () => {
    const t = await setup({ perMinute: 5, answer: () => ({ error: '20003', auth: true, again: true }) })
    try {
      const id = t.campaign()
      await t.sms.tick()
      await t.sms.tick()
      assert.equal(t.sent.length, 1)
      assert.equal(t.store.campaign(id)!.state, 'paused')
      assert.equal(t.told.length, 1)
    } finally { t.sms.close() }
  })
  test('once the keys are fixed and the campaign resumes, the contact the provider refused is texted', async () => {
    let refuse = true
    const t = await setup({ perMinute: 5, answer: () => (refuse ? { error: '20003', auth: true, again: true } : undefined) })
    try {
      const id = t.campaign()
      await t.sms.tick()
      refuse = false
      t.store.move(id, 'resume')
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A, A, B, C])
    } finally { t.sms.close() }
  })
  test('a busy provider leaves the contact for the next tick instead of failing it', async () => {
    let busy = true
    const t = await setup({ perMinute: 5, answer: () => (busy ? { error: 'http-429', auth: false, again: true } : undefined) })
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      busy = false
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A, A])
      assert.deepEqual(t.store.report(id)!.errors, {})
    } finally { t.sms.close() }
  })
  test('a tick that comes while a batch is still sending is dropped, so the per-minute cap holds', async () => {
    let release = () => {}
    const slow = new Promise<void>(r => { release = r })
    const t = await setup({ perMinute: 2, answer: async () => { await slow; return undefined } })
    try {
      t.campaign()
      const first = t.sms.tick(), second = t.sms.tick()
      release()
      await Promise.all([first, second])
      assert.equal(t.sent.length, 2)
    } finally { t.sms.close() }
  })
  test('a batch stops when 8pm Eastern comes during it', async () => {
    const t: Setup = await setup({ perMinute: 5, answer: () => { t.setNow(NIGHT); return undefined } })
    try {
      t.campaign()
      await t.sms.tick()
      assert.equal(t.sent.length, 1)
    } finally { t.sms.close() }
  })
  test('a cancel during a batch stops the rest of it', async () => {
    let id = 0
    const t: Setup = await setup({ perMinute: 5, answer: () => { t.store.move(id, 'cancel'); return undefined } })
    try {
      id = t.campaign()
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A])
    } finally { t.sms.close() }
  })
  test('a STOP during a batch keeps that number out of the rest of it', async () => {
    const t: Setup = await setup({ perMinute: 5, answer: to => { if (to === A) t.store.heard(B, 'SM0STOP', 'stop'); return undefined } })
    try {
      t.campaign()
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A, C])
    } finally { t.sms.close() }
  })
  test('a report that fails to post keeps the campaign sending, and the next tick posts it', async () => {
    let fail = true
    const t = await setup({ perMinute: 5, postFails: () => fail })
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      await t.sms.tick()
      assert.equal(t.store.campaign(id)!.state, 'sending')
      fail = false
      await t.sms.tick()
      await t.sms.tick()
      assert.equal(t.store.campaign(id)!.state, 'done')
      assert.equal(t.posts.length, 1)
    } finally { t.sms.close() }
  })
  test('a report that fails to post 3 times goes to the owner instead, and the campaign is done', async () => {
    const t = await setup({ perMinute: 5, postFails: () => true })
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      await t.sms.tick()
      await t.sms.tick()
      assert.deepEqual([t.store.campaign(id)!.state, t.told], ['sending', []])
      await t.sms.tick()
      assert.equal(t.store.campaign(id)!.state, 'done')
      assert.equal(t.told.length, 1)
      assert.match(t.told[0]!, /promo/)
      await t.sms.tick()
      assert.equal(t.told.length, 1)
    } finally { t.sms.close() }
  })
  test('a report waits for the last text in flight, so a busy answer to it still texts that contact', async () => {
    let answer: (a: Answer) => void = () => {}, busy = true
    const t = await setup({ perMinute: 5, answer: () => (busy ? new Promise<Answer>(r => { answer = r }) : undefined) })
    try {
      const id = t.campaign([A])
      const sending = t.sms.tick()
      await new Promise(r => setImmediate(r))
      const reporting = t.sms.tick()
      busy = false
      answer({ error: 'http-429', auth: false, again: true })
      await Promise.all([sending, reporting])
      assert.deepEqual([t.store.campaign(id)!.state, t.posts.length], ['sending', 0])
      await t.sms.tick()
      await t.sms.tick()
      assert.deepEqual(t.sent.map(s => s.to), [A, A])
      assert.deepEqual([t.store.campaign(id)!.state, t.posts.length], ['done', 1])
    } finally { t.sms.close() }
  })
  test('a pause clears the failed post count, so a resumed campaign gets 3 fresh tries', async () => {
    const t = await setup({ perMinute: 5, postFails: () => true })
    try {
      const id = t.campaign([A])
      await t.sms.tick()
      await t.sms.tick()
      t.store.move(id, 'pause')
      await t.sms.tick()
      t.store.move(id, 'resume')
      await t.sms.tick()
      await t.sms.tick()
      assert.deepEqual([t.store.campaign(id)!.state, t.told], ['sending', []])
    } finally { t.sms.close() }
  })
  test('a report post that hangs does not hold up the texts of another campaign', async () => {
    let hang = false, sentB: () => void = () => {}
    const reachedB = new Promise<void>(r => { sentB = r })
    const t = await setup({ perMinute: 5, postHangs: () => hang, answer: to => { if (to === B) sentB(); return undefined } })
    try {
      t.campaign([A])
      await t.sms.tick()
      t.campaign([B])
      hang = true
      void t.sms.tick()
      const timedOut = new Promise<string>(r => setTimeout(() => r('timed out'), 1000).unref())
      assert.equal(await Promise.race([reachedB.then(() => 'sent'), timedOut]), 'sent')
    } finally { t.sms.close() }
  })
})

describe('a reply to one person', () => {
  test('goes to the number behind the session key and is tracked', async () => {
    const t = await setup()
    try {
      const person = t.store.person(A)
      assert.equal(await t.sms.reply(`sms:${person}`, 'We open at 9.'), true)
      assert.deepEqual(t.sent, [{ to: A, body: 'We open at 9.' }])
      assert.equal(t.store.status('SM0TEST1', 'delivered'), true)
    } finally { t.sms.close() }
  })
  test('is refused for an opted-out number or an unknown key, and nothing is sent', async () => {
    const t = await setup()
    try {
      const person = t.store.person(A)
      t.store.optOut(person)
      assert.equal(await t.sms.reply(`sms:${person}`, 'hi'), false)
      assert.equal(await t.sms.reply('sms:999', 'hi'), false)
      assert.equal(t.sent.length, 0)
    } finally { t.sms.close() }
  })
})
