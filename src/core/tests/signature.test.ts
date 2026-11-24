import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { slackSigned, slackStampFresh } from '../signature.ts'

const SECRET = 'signing-test-secret'
const NOW = 1_800_000_000_000
const STAMP = String(NOW / 1000)
const BODY = '{"type":"event_callback","event":{"type":"message"}}'
const sign = (stamp: string, body: string, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${stamp}:${body}`).digest('hex')}`

test('a Slack request signed with the signing secret over v0, its timestamp and its body is accepted', () => {
  assert.equal(slackSigned(SECRET, STAMP, BODY, sign(STAMP, BODY), NOW), true)
  assert.equal(slackSigned(SECRET, STAMP, Buffer.from(BODY), sign(STAMP, BODY), NOW), true)
})

test('a signature from another secret, over another body, or over another timestamp is refused', () => {
  assert.equal(slackSigned(SECRET, STAMP, BODY, sign(STAMP, BODY, 'other-secret'), NOW), false)
  assert.equal(slackSigned(SECRET, STAMP, BODY, sign(STAMP, `${BODY} `), NOW), false)
  assert.equal(slackSigned(SECRET, STAMP, BODY, sign(String(NOW / 1000 - 1), BODY), NOW), false)
})

test('a missing secret, signature or timestamp is refused', () => {
  assert.equal(slackSigned('', STAMP, BODY, sign(STAMP, BODY, ''), NOW), false)
  assert.equal(slackSigned(SECRET, STAMP, BODY, undefined, NOW), false)
  assert.equal(slackSigned(SECRET, undefined, BODY, sign('', BODY), NOW), false)
})

test('a timestamp more than 5 minutes from now is refused, even with a good signature, so an old request cannot be replayed', () => {
  const old = String(NOW / 1000 - 301), ahead = String(NOW / 1000 + 301)
  assert.equal(slackSigned(SECRET, old, BODY, sign(old, BODY), NOW), false)
  assert.equal(slackSigned(SECRET, ahead, BODY, sign(ahead, BODY), NOW), false)
  assert.equal(slackStampFresh(String(NOW / 1000 - 300), NOW), true)
})

test('a timestamp that is not a whole number of seconds is refused, never read as fresh', () => {
  for (const stamp of ['', 'abc', '1.5e9', ' 1800000000', '-1']) assert.equal(slackStampFresh(stamp, NOW), false, stamp)
  assert.equal(slackStampFresh(undefined, NOW), false)
})
