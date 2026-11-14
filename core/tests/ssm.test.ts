import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { relayHeader, ssmEligible } from '../ssm.ts'

describe('the relay header: token target port [region]', () => {
  test('a good line parses', () => {
    assert.deepEqual(relayHeader('tok123 i-0123456789abcdef0 22 us-west-1'), { token: 'tok123', target: 'i-0123456789abcdef0', port: 22, region: 'us-west-1' })
    assert.deepEqual(relayHeader('t mi-0123456789abcdef0 65535'), { token: 't', target: 'mi-0123456789abcdef0', port: 65535, region: undefined })
    assert.deepEqual(relayHeader('t i-01234567 1'), { token: 't', target: 'i-01234567', port: 1, region: undefined })
  })
  test('anything else is refused with a reason', () => {
    for (const l of ['', 't', 't i-0123456789abcdef0', 't i-0123456789abcdef0 0', 't i-0123456789abcdef0 65536', 't i-0123456789abcdef0 22.5', 't i-0123456789abcdef0 0x16',
      't i-0123456 22', 't i-0123456789abcdef012 22', 't I-0123456789abcdef0 22', 't i-0123456789abcdeg0 22', 't myhost 22', 't i-0123456789abcdef0;id 22',
      't i-0123456789abcdef0 22 us-west-1 extra', 't i-0123456789abcdef0 22 --profile', 't i-0123456789abcdef0 22 $(id)']) {
      const r = relayHeader(l)
      assert.ok('error' in r && r.error.length > 0, l)
    }
  })
})

describe('which threads may hold a relay token', () => {
  test('the owner threads on Slack may, with or without a lane', () => {
    for (const k of ['dm', 'C0123ABC:1730.55', 'D0123ABC:1730.55', 'G0123ABC:1730.55', 'dm#side-x']) assert.equal(ssmEligible(k), true, k)
  })
  test('email, WhatsApp, voice, another agent and an odd key may not', () => {
    for (const k of ['mail:abc', 'wa:123', 'voice:xyz', 'other/dm', 'other/C0123ABC:1730.55', 'x', '']) assert.equal(ssmEligible(k), false, k)
  })
})
