import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { startSessionCall, ssmEligible } from '../ssm.ts'

// What aws sends: session-manager-plugin <response> <region> StartSession <profile> <parameters> <endpoint>
const response = (streamUrl = 'wss://ssmmessages.us-west-1.amazonaws.com/v1/data-channel/sess-1?role=publish_subscribe') =>
  JSON.stringify({ SessionId: 'sess-1', TokenValue: 'tv', StreamUrl: streamUrl })
const params = JSON.stringify({ Target: 'i-0123456789abcdef0', DocumentName: 'AWS-StartSSHSession', Parameters: { portNumber: ['22'] } })
const good = (): string[] => [response(), 'us-west-1', 'StartSession', '', params, 'https://ssm.us-west-1.amazonaws.com']
const bad = (i: number, v: string) => good().map((a, j) => j === i ? v : a)
const refused = (x: unknown) => 'error' in startSessionCall(x)

describe('the one call the hub runs for a session', () => {
  test('a good StartSession passes with its arguments unchanged, and names the region and target', () => {
    assert.deepEqual(startSessionCall(good()), { args: good(), region: 'us-west-1', target: 'i-0123456789abcdef0' })
    assert.equal(refused(bad(3, 'staging-admin')), false)
  })
  test('China regions use the .com.cn hosts', () => {
    const a = [response('wss://ssmmessages.cn-north-1.amazonaws.com.cn/v1/data-channel/s'), 'cn-north-1', 'StartSession', '', params, 'https://ssm.cn-north-1.amazonaws.com.cn']
    assert.equal(refused(a), false)
  })
  test('another operation is refused', () => {
    for (const op of ['TerminateSession', 'ResumeSession', 'startsession', '']) assert.ok(refused(bad(2, op)), op)
  })
  test('a stream host that is not this region ssmmessages is refused', () => {
    for (const u of ['wss://evil.example.com/v1', 'wss://ssmmessages.us-east-1.amazonaws.com/v1', 'wss://ssmmessages.us-west-1.amazonaws.com.evil.com/v1',
      'wss://ssmmessages.us-west-1.amazonaws.com@evil.com/v1', 'wss://user:pw@ssmmessages.us-west-1.amazonaws.com/v1', 'wss://ssmmessages.us-west-1.amazonaws.com:8443/v1']) {
      assert.ok(refused(bad(0, response(u))), u)
    }
  })
  test('a stream URL that is not wss is refused', () => {
    for (const u of ['ws://ssmmessages.us-west-1.amazonaws.com/v1', 'https://ssmmessages.us-west-1.amazonaws.com/v1', 'ssmmessages.us-west-1.amazonaws.com', '']) {
      assert.ok(refused(bad(0, response(u))), u)
    }
  })
  test('an endpoint that is not https ssm for this region is refused', () => {
    for (const e of ['http://ssm.us-west-1.amazonaws.com', 'https://ssm.us-east-1.amazonaws.com', 'https://evil.example.com', 'https://ssm.us-west-1.amazonaws.com.evil.com', 'https://ssm.us-west-1.amazonaws.com@evil.com', '']) {
      assert.ok(refused(bad(5, e)), e)
    }
  })
  test('a region that is not a region name is refused', () => {
    for (const r of ['', 'us west', '--profile', '$(id)', 'us-west-1;id']) assert.ok(refused(bad(1, r)), r)
  })
  test('bad JSON, a missing field and a profile with odd characters are refused', () => {
    for (const [i, v] of [[0, 'not json'], [0, '[]'], [0, '{}'], [0, '{"StreamUrl":5}'], [4, 'not json'], [4, '[]'], [4, '{}'], [3, '--x y'], [3, 'a;b'], [3, '$(id)']] as const) {
      assert.ok(refused(bad(i, v)), `${i} ${v}`)
    }
  })
  test('extra, missing or non-string arguments are refused', () => {
    assert.ok(refused([...good(), 'extra']))
    assert.ok(refused(good().slice(0, 5)))
    assert.ok(refused([5, ...good().slice(1)]))
    for (const x of [undefined, null, 'x', {}, 7]) assert.ok(refused(x))
  })
  test('the error never repeats the stream URL or the token value', () => {
    const e = (startSessionCall(bad(0, response('wss://evil.example.com/secret-path'))) as { error: string }).error
    assert.ok(!e.includes('secret-path') && !e.includes('evil') && !e.includes('tv'))
  })
})

describe('which threads may hold a relay token', () => {
  test('the owner threads on Slack may, with or without a lane', () => {
    for (const k of ['dm', 'C0123ABC:1730.55', 'D0123ABC:1730.55', 'G0123ABC:1730.55', 'dm#side-x']) assert.equal(ssmEligible(k), true, k)
  })
  test('email, WhatsApp, voice, another agent and an odd key may not', () => {
    for (const k of ['mail:abc', 'wa:123', 'voice:xyz', 'other/dm', 'other/C0123ABC:1730.55', 'x', '', 'dm#side-dream', 'C0123ABC:1730.55#side-kdream-news']) assert.equal(ssmEligible(k), false, k)
  })
})
