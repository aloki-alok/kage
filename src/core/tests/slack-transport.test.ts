import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config, Secrets } from '../config.ts'
import { slackTransport } from '../slack-transport.ts'
import { tunnelPlan, tunnelRecord, tunnelRoutes } from '../tunnel.ts'

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
