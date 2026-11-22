import { test } from 'node:test'
import assert from 'node:assert/strict'
import { smsSender } from '../sms-send.ts'

const fake = (status: number, body: unknown, seen: { url: string; init: RequestInit }[] = []) =>
  (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status }) }) as unknown as typeof fetch

test('Twilio: a form post with basic auth and the status callback, and the message sid back', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const send = smsSender({ provider: 'twilio', statusUrl: 'https://kage.example.test/sms', accountSid: 'AC0TEST', twilioAuthToken: 'tok', fetch: fake(201, { sid: 'SM0TEST1' }, seen) })
  assert.deepEqual(await send('+14155550101', '+14155550199', 'hi'), { id: 'SM0TEST1' })
  assert.equal(seen[0]!.url, 'https://api.twilio.com/2010-04-01/Accounts/AC0TEST/Messages.json')
  const form = new URLSearchParams(String(seen[0]!.init.body))
  assert.deepEqual([form.get('To'), form.get('From'), form.get('Body'), form.get('StatusCallback')], ['+14155550101', '+14155550199', 'hi', 'https://kage.example.test/sms'])
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('AC0TEST:tok').toString('base64')}`)
})

test('Twilio: a refusal returns its code, and a 401 is an auth failure, and a 401 or a 500 may be tried again', async () => {
  const base = { provider: 'twilio' as const, statusUrl: 'u', accountSid: 'AC0TEST', twilioAuthToken: 'tok' }
  assert.deepEqual(await smsSender({ ...base, fetch: fake(400, { code: 21610, message: 'unsubscribed' }) })('+1', '+1', 'x'), { error: '21610', auth: false, again: false })
  assert.deepEqual(await smsSender({ ...base, fetch: fake(401, { code: 20003 }) })('+1', '+1', 'x'), { error: '20003', auth: true, again: true })
  assert.deepEqual(await smsSender({ ...base, fetch: fake(500, 'oops') })('+1', '+1', 'x'), { error: 'http-500', auth: false, again: true })
})

test('a 429 may be tried again, and a 200 with no id may not, because the text may have gone out', async () => {
  const base = { provider: 'twilio' as const, statusUrl: 'u', accountSid: 'AC0TEST', twilioAuthToken: 'tok' }
  assert.deepEqual(await smsSender({ ...base, fetch: fake(429, { code: 20429 }) })('+1', '+1', 'x'), { error: '20429', auth: false, again: true })
  assert.deepEqual(await smsSender({ ...base, fetch: fake(201, {}) })('+1', '+1', 'x'), { error: 'no-id', auth: false, again: false })
})

test('Telnyx: a JSON post with a bearer key, the id back, and the first error code on a refusal', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const base = { provider: 'telnyx' as const, statusUrl: 'https://kage.example.test/sms', telnyxApiKey: 'key' }
  assert.deepEqual(await smsSender({ ...base, fetch: fake(200, { data: { id: 'msg-1' } }, seen) })('+14155550101', '+14155550199', 'hi'), { id: 'msg-1' })
  assert.equal(seen[0]!.url, 'https://api.telnyx.com/v2/messages')
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { from: '+14155550199', to: '+14155550101', text: 'hi', webhook_url: 'https://kage.example.test/sms' })
  assert.deepEqual(await smsSender({ ...base, fetch: fake(403, { errors: [{ code: '10009', title: 'Auth' }] }) })('+1', '+1', 'x'), { error: '10009', auth: true, again: true })
})
