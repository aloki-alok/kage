import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config, Secrets } from '../config.ts'
import { slackRequest, slackTransport } from '../slack-transport.ts'
import { tunnelPlan, tunnelRecord, tunnelRoutes } from '../tunnel.ts'

const JSON_TYPE = 'application/json'
const FORM = 'application/x-www-form-urlencoded'

describe('what a request to the Slack route means', () => {
  test('a url_verification is a challenge to answer', () => {
    assert.deepEqual(slackRequest(JSON_TYPE, JSON.stringify({ type: 'url_verification', token: 'x', challenge: 'c-test' })), { kind: 'challenge', challenge: 'c-test' })
  })

  test('an event_callback is handed on under its inner event type, as Socket Mode names it', () => {
    const body = { type: 'event_callback', event_id: 'Ev0TEST1', event: { type: 'message', channel: 'C0TEST1', ts: '1.1' } }
    assert.deepEqual(slackRequest(`${JSON_TYPE}; charset=utf-8`, JSON.stringify(body)), { kind: 'dispatch', name: 'message', body, event: body.event })
  })

  test('a slash command form is handed on as slash_commands with its fields', () => {
    const form = new URLSearchParams({ command: '/truecaller', text: '9876543210', user_id: 'U0TEST1', team_id: 'T0TEST1', response_url: 'https://hooks.slack.test/r' })
    assert.deepEqual(slackRequest(FORM, form.toString()), { kind: 'dispatch', name: 'slash_commands', body: Object.fromEntries(form) })
  })

  test('a button press form is handed on as interactive with its payload parsed', () => {
    const payload = { type: 'block_actions', user: { id: 'U0TEST1' }, actions: [{ action_id: 'approve' }] }
    assert.deepEqual(slackRequest(FORM, new URLSearchParams({ payload: JSON.stringify(payload) }).toString()), { kind: 'dispatch', name: 'interactive', body: payload })
  })

  test('a rate-limit notice and an ssl_check are handed on under their own names, so no message or command listener takes them', () => {
    assert.deepEqual(slackRequest(JSON_TYPE, '{"type":"app_rate_limited","minute_rate_limited":1}'), { kind: 'dispatch', name: 'app_rate_limited', body: { type: 'app_rate_limited', minute_rate_limited: 1 } })
    assert.deepEqual(slackRequest(FORM, 'ssl_check=1&token=x'), { kind: 'dispatch', name: 'ssl_check', body: { ssl_check: '1', token: 'x' } })
  })

  test('anything else means nothing: bad JSON, a bare value, an event with no type, an unknown form or content type', () => {
    for (const [type, body] of [[JSON_TYPE, '{'], [JSON_TYPE, 'null'], [JSON_TYPE, '7'], [JSON_TYPE, '{"type":"event_callback","event":{}}'],
      [FORM, 'payload=%7B'], [FORM, 'payload=null'], [FORM, 'text=hi'], ['text/plain', '{"type":"url_verification","challenge":"c"}']] as const)
      assert.equal(slackRequest(type, body), undefined, `${type} ${body}`)
  })
})

const settings = (slack: Config['slack'], signing?: string, tunnel?: Config['tunnel']) =>
  ({ config: { version: 1, ...(slack && { slack }), ...(tunnel && { tunnel }) } as Config, secrets: { slack: { bot: 'b', user: 'u', app: 'a', ...(signing && { signing }) } } as Secrets })

describe('which way Slack reaches Kage', () => {
  test('auto with no public route, or no signing secret, keeps Socket Mode, so an install that never set them is unchanged', () => {
    assert.equal(slackTransport(settings(undefined)), 'socket')
    assert.equal(slackTransport(settings({ transport: 'auto' }, 's')), 'socket')
    assert.equal(slackTransport(settings({ publicUrl: 'https://kage.example.test/slack' })), 'socket')
  })

  test('auto with a public URL and the signing secret takes HTTP', () => {
    assert.equal(slackTransport(settings({ publicUrl: 'https://kage.example.test/slack' }, 's')), 'http')
  })

  test('auto takes HTTP once kage tunnel on opened the Slack route', () => {
    const before = settings(undefined, 's')
    const plan = tunnelPlan(before, { funnel: true, status: {} }, 'on')
    assert.ok(Object.keys(plan.opens).includes('/slack'))
    const after = { ...before, config: { ...before.config, tunnel: { provider: 'tailscale' as const, targets: tunnelRecord(before, undefined, plan.opens) } } }
    assert.equal(slackTransport(after), 'http')
    assert.equal(slackTransport({ ...after, config: { ...after.config, tunnel: { provider: 'off', targets: after.config.tunnel.targets } } }), 'socket')
  })

  test('a transport set by hand wins over what auto would pick', () => {
    assert.equal(slackTransport(settings({ transport: 'socket', publicUrl: 'https://kage.example.test/slack' }, 's')), 'socket')
    assert.equal(slackTransport(settings({ transport: 'http' })), 'http')
  })

  test('the tunnel opens the Slack route only when HTTP can be used: a signing secret, and a transport not set to socket', () => {
    assert.deepEqual(tunnelRoutes(settings(undefined)).map(r => r.name), [])
    assert.deepEqual(tunnelRoutes(settings({ transport: 'socket' }, 's')).map(r => r.name), [])
    assert.deepEqual(tunnelRoutes(settings(undefined, 's')), [{ name: 'slack', port: 8796, paths: ['/slack'], reach: 'internet' }])
  })
})
