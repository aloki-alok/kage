import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { telnyxEvent, telnyxSigned, twilioBodySigned, twilioEvent, twilioSigned, twilioStreamEvents } from '../sms-providers.ts'

describe('a Twilio webhook is checked before it is read', () => {
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
  const params = { CallSid: 'CA1234567890ABCDE', Digits: '1234', From: '+14158675309', To: '+18005551212', Caller: '+14158675309' }
  test("Twilio's own published example signature passes", () => {
    assert.equal(twilioSigned('12345', url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), true)
  })
  test('a changed parameter, another URL, another token or no header fails', () => {
    assert.equal(twilioSigned('12345', url, { ...params, Digits: '1235' }, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false)
    assert.equal(twilioSigned('12345', `${url}&x=1`, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false)
    assert.equal(twilioSigned('54321', url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false)
    assert.equal(twilioSigned('12345', url, params, undefined), false)
    assert.equal(twilioSigned('', url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false)
  })
})

describe('a Twilio Event Streams post is checked before it is read', () => {
  const body = '[{"type":"x"}]'
  const url = 'https://kage.example.test/sms/events?bodySHA256=d3b89d368528f8a83b4ebd125bb252a36ad0a8b212778aed5768e3341ebfbc3d'
  const sig = '+713TmrK2nyFF/B/YMK9XyNCVBQ='
  test("a signature made by Twilio's own validator passes", () => {
    assert.equal(twilioBodySigned('12345', url, body, sig), true)
  })
  test('a changed body, a missing body hash, another token or no header fails', () => {
    assert.equal(twilioBodySigned('12345', url, '[{"type":"y"}]', sig), false)
    assert.equal(twilioBodySigned('12345', 'https://kage.example.test/sms/events', body, sig), false)
    assert.equal(twilioBodySigned('54321', url, body, sig), false)
    assert.equal(twilioBodySigned('12345', url, body, undefined), false)
  })
})

describe('what a Twilio Event Streams post means', () => {
  const received = (data: Record<string, unknown>) => ({ type: 'com.twilio.messaging.inbound-message.received', data })
  const text = { messageSid: 'SM0TEST1', from: '+14155550100', to: '+14155550199', body: 'hi there' }
  test('each incoming text in the batch', () => {
    assert.deepEqual(twilioStreamEvents([received(text), received({ ...text, messageSid: 'SM0TEST2', body: '' })]), [
      { kind: 'inbound', id: 'SM0TEST1', from: '+14155550100', to: '+14155550199', text: 'hi there' },
      { kind: 'inbound', id: 'SM0TEST2', from: '+14155550100', to: '+14155550199', text: '' },
    ])
  })
  test('a single event that is not in an array still counts', () => {
    assert.equal(twilioStreamEvents(received(text)).length, 1)
  })
  test('other event types, broken events and bodies that are not events are ignored', () => {
    assert.deepEqual(twilioStreamEvents([{ type: 'com.twilio.messaging.message.delivered', data: text }, received({ ...text, messageSid: undefined }), received({ ...text, body: 7 }), null, 3]), [])
    assert.deepEqual(twilioStreamEvents(null), [])
    assert.deepEqual(twilioStreamEvents('text'), [])
  })
})

describe('a Telnyx webhook is checked before it is read', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  const body = '{"data":{"event_type":"message.received"}}'
  const signed = (ts: string, b = body) => sign(null, Buffer.from(`${ts}|${b}`), privateKey).toString('base64')
  test('a body signed with the key the portal shows passes within five minutes', () => {
    assert.equal(telnyxSigned(raw, '1800000000', body, signed('1800000000'), 1800000100), true)
  })
  test('an old timestamp, a changed body, another key or a missing header fails', () => {
    assert.equal(telnyxSigned(raw, '1800000000', body, signed('1800000000'), 1800000301), false)
    assert.equal(telnyxSigned(raw, '1800000000', `${body} `, signed('1800000000'), 1800000100), false)
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    assert.equal(telnyxSigned(other, '1800000000', body, signed('1800000000'), 1800000100), false)
    assert.equal(telnyxSigned(raw, undefined, body, signed('1800000000'), 1800000100), false)
    assert.equal(telnyxSigned(raw, '1800000000', body, undefined, 1800000100), false)
    assert.equal(telnyxSigned('not a key', '1800000000', body, signed('1800000000'), 1800000100), false)
  })
})

describe('what a Twilio webhook means', () => {
  test('an incoming text', () => {
    assert.deepEqual(twilioEvent({ MessageSid: 'SM0TEST1', SmsStatus: 'received', From: '+14155550100', To: '+14155550199', Body: 'hi there' }),
      { kind: 'inbound', id: 'SM0TEST1', from: '+14155550100', to: '+14155550199', text: 'hi there' })
  })
  test('a status callback, in our own status words, with its error code', () => {
    assert.deepEqual(twilioEvent({ MessageSid: 'SM0TEST2', MessageStatus: 'delivered' }), { kind: 'status', id: 'SM0TEST2', status: 'delivered' })
    assert.deepEqual(twilioEvent({ MessageSid: 'SM0TEST2', MessageStatus: 'undelivered', ErrorCode: '30007' }), { kind: 'status', id: 'SM0TEST2', status: 'undelivered', error: '30007' })
    assert.deepEqual(twilioEvent({ MessageSid: 'SM0TEST2', MessageStatus: 'sending' }), { kind: 'status', id: 'SM0TEST2', status: 'sent' })
    assert.deepEqual(twilioEvent({ MessageSid: 'SM0TEST2', MessageStatus: 'canceled' }), { kind: 'status', id: 'SM0TEST2', status: 'failed' })
  })
  test('anything else is ignored', () => {
    assert.equal(twilioEvent({ MessageSid: 'SM0TEST3', MessageStatus: 'mystery' }), undefined)
    assert.equal(twilioEvent({ From: '+14155550100' }), undefined)
  })
})

describe('what a Telnyx webhook means', () => {
  const event = (event_type: string, payload: unknown) => ({ data: { event_type, id: 'ev-1', payload } })
  test('an incoming text', () => {
    assert.deepEqual(telnyxEvent(event('message.received', { id: 'msg-1', from: { phone_number: '+14155550100' }, to: [{ phone_number: '+14155550199' }], text: 'STOP' })),
      { kind: 'inbound', id: 'msg-1', from: '+14155550100', to: '+14155550199', text: 'STOP' })
  })
  test('a sent or finalized message, with the first error code', () => {
    assert.deepEqual(telnyxEvent(event('message.finalized', { id: 'msg-2', to: [{ status: 'delivered' }] })), { kind: 'status', id: 'msg-2', status: 'delivered' })
    assert.deepEqual(telnyxEvent(event('message.finalized', { id: 'msg-2', to: [{ status: 'delivery_failed' }], errors: [{ code: '40300', title: 'x' }] })), { kind: 'status', id: 'msg-2', status: 'undelivered', error: '40300' })
    assert.deepEqual(telnyxEvent(event('message.sent', { id: 'msg-2', to: [{ status: 'sent' }] })), { kind: 'status', id: 'msg-2', status: 'sent' })
    assert.deepEqual(telnyxEvent(event('message.finalized', { id: 'msg-2', to: [{ status: 'sending_failed' }] })), { kind: 'status', id: 'msg-2', status: 'failed' })
  })
  test('a body of the wrong shape is ignored, never a crash', () => {
    for (const bad of [null, 3, 'x', {}, { data: null }, event('message.received', { id: 'm' }), event('call.initiated', { id: 'c' }), event('message.finalized', { id: 'm', to: [{ status: 'odd' }] })])
      assert.equal(telnyxEvent(bad), undefined)
  })
})
