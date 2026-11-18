import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { metaEvents } from '../meta.ts'

const page = (messaging: unknown[], object = 'page') => ({ object, entry: [{ id: 'P1', time: 1, messaging }] })

describe("Meta's webhook as events", () => {
  test('a lead message carries the sender, the id and the text', () => {
    const ev = metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, message: { mid: 'm1', text: 'hi there' } }]))
    assert.deepEqual(ev, [{ kind: 'message', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'm1', text: 'hi there', at: 5 }])
  })

  test('an ad click carries its ad id, from the event or from the message', () => {
    const a = metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, referral: { source: 'ADS', ad_id: 'AD9' }, message: { mid: 'm1', text: 'x' } }]))
    const b = metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, message: { mid: 'm2', text: 'x', referral: { source: 'ADS', ad_id: 'AD7' } } }]))
    assert.equal(a[0]?.kind === 'message' && a[0].adId, 'AD9')
    assert.equal(b[0]?.kind === 'message' && b[0].adId, 'AD7')
  })

  test('a tapped starter question (a postback) reads as the text the lead tapped', () => {
    const ev = metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, postback: { mid: 'm3', title: 'Can I learn more about your business?', payload: 'x' } }]))
    assert.equal(ev[0]?.kind === 'message' && ev[0].text, 'Can I learn more about your business?')
  })

  test('an echo is a reply the Page sent: its user is the recipient, and it keeps the app that sent it', () => {
    const ev = metaEvents(page([{ sender: { id: 'P1' }, recipient: { id: 'U1' }, timestamp: 6, message: { mid: 'm4', is_echo: true, app_id: 263902037430900, text: 'a person typed this' } }]))
    assert.deepEqual(ev, [{ kind: 'echo', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'm4', appId: '263902037430900', at: 6 }])
  })

  test('Instagram messages come in the same shape', () => {
    const ev = metaEvents(page([{ sender: { id: 'IGU' }, recipient: { id: 'IG1' }, timestamp: 5, message: { mid: 'i1', text: 'price?' } }], 'instagram'))
    assert.equal(ev[0]?.channel, 'instagram')
  })

  test('a new comment on a Page post, from someone other than the Page', () => {
    const body = { object: 'page', entry: [{ id: 'P1', time: 1, changes: [
      { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', post_id: 'P1_9', parent_id: 'P1_9', message: 'Hire', from: { id: 'U5', name: 'A Lead' }, created_time: 7 } },
      { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C2', post_id: 'P1_9', message: 'our own reply', from: { id: 'P1', name: 'OmniDimension' }, created_time: 8 } },
      { field: 'feed', value: { item: 'comment', verb: 'edited', comment_id: 'C3', post_id: 'P1_9', message: 'x', from: { id: 'U6' }, created_time: 9 } },
      { field: 'feed', value: { item: 'reaction', verb: 'add', post_id: 'P1_9', from: { id: 'U7' } } },
    ] }] }
    assert.deepEqual(metaEvents(body), [{ kind: 'comment', channel: 'facebook_comment', pageId: 'P1', user: 'U5', name: 'A Lead', id: 'C1', postId: 'P1_9', parentId: 'P1_9', text: 'Hire', at: 7000 }])
  })

  test('reads, deliveries, attachments with no text and a broken body give no events', () => {
    assert.deepEqual(metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, read: { watermark: 4 } }])), [])
    assert.deepEqual(metaEvents(page([{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 5, message: { mid: 'm5', attachments: [{ type: 'image' }] } }])), [])
    assert.deepEqual(metaEvents(null), [])
    assert.deepEqual(metaEvents({ object: 'page', entry: 'x' }), [])
    assert.deepEqual(metaEvents({ object: 'whatsapp_business_account', entry: [] }), [])
  })
})
