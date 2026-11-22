import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { routeStates, tunnelLines, tunnelPlan, tunnelRoutes } from '../tunnel.ts'
import type { Config, Secrets } from '../config.ts'

const HOST = 'box.tail1.ts.net'
const all = { config: { connectors: { github: { login: 'me' }, voice: {}, meeting: {} }, tripwires: { hookPort: 8792 } } as Config,
  secrets: { githubSecret: 's', voiceToken: 'v', meetingToken: 'm' } as Secrets }
const none = { config: { connectors: {} } as Config, secrets: {} as Secrets }
const serving = (o: { funnel?: boolean; port?: number; paths?: Record<string, string>; tcp?: Record<string, object> }) => {
  const at = `${HOST}:${o.port ?? 8443}`
  return {
    TCP: { ...o.paths && { [o.port ?? 8443]: { HTTPS: true } }, ...o.tcp },
    ...o.paths && { Web: { [at]: { Handlers: Object.fromEntries(Object.entries(o.paths).map(([p, to]) => [p, { Proxy: to }])) } } },
    ...o.funnel && { AllowFunnel: { [at]: true } },
  }
}
const KAGE = { '/github': 'http://127.0.0.1:8789/github', '/mcp': 'http://127.0.0.1:8787/mcp', '/voice': 'http://127.0.0.1:8787/voice', '/hook': 'http://127.0.0.1:8792/hook' }
const MEETING = { 8790: { TCPForward: '127.0.0.1:8790' } }
const plan = (s: typeof all, status: object, o: { funnel?: boolean; to?: 'on' | 'off' } = {}) => tunnelPlan(s, { funnel: o.funnel ?? true, status }, o.to ?? 'on')

describe('one tunnel for every Kage port another machine needs', () => {
  test('each connector that is on gets one route: what the internet calls is public, the meeting bot stays on the tailnet', () => {
    assert.deepEqual(tunnelRoutes(all), [
      { name: 'github', port: 8789, paths: ['/github'], reach: 'internet' },
      { name: 'voice', port: 8787, paths: ['/mcp', '/voice'], reach: 'internet' },
      { name: 'hooks', port: 8792, paths: ['/hook'], reach: 'internet' },
      { name: 'meeting', port: 8790, paths: [], reach: 'tailnet' },
    ])
  })

  test('a connector that is off, or a GitHub read by notifications, gets no route, and a set port is used', () => {
    const some = { config: { connectors: { github: { login: 'me', port: 9100 }, voice: { on: false } }, tripwires: { hookPort: 8792, on: false } } as Config,
      secrets: { githubSecret: 's', voiceToken: 'v' } as Secrets }
    assert.deepEqual(tunnelRoutes(some), [{ name: 'github', port: 9100, paths: ['/github'], reach: 'internet' }])
    assert.deepEqual(tunnelRoutes({ config: { connectors: { github: { login: 'me' } } } as Config, secrets: { githubToken: 't' } as Secrets }), [])
  })

  test('opening funnels each public path on Kage\'s own port 8443 with its path kept, serves the meeting port on the tailnet, and never touches 443', () => {
    const p = plan(all, {})
    assert.deepEqual(p.run, [
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/github', 'http://127.0.0.1:8789/github'],
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/mcp', 'http://127.0.0.1:8787/mcp'],
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/voice', 'http://127.0.0.1:8787/voice'],
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/hook', 'http://127.0.0.1:8792/hook'],
      ['serve', '--bg', '--yes', '--tcp=8790', 'tcp://127.0.0.1:8790'],
    ])
    assert.deepEqual([p.foreign, p.waitsForFunnel], [[], false])
    assert.deepEqual(plan(all, { ...serving({ funnel: true, paths: KAGE, tcp: MEETING }) }).run, [])
  })

  test('a route of a connector turned off since is closed, even a hook whose port is now unset, and a route that moved port is opened again', () => {
    const stale = serving({ funnel: true, paths: { ...KAGE, '/github': 'http://127.0.0.1:9100/github' }, tcp: MEETING })
    assert.deepEqual(plan({ config: { connectors: { github: { login: 'me' } } } as Config, secrets: { githubSecret: 's' } as Secrets }, stale).run, [
      ['funnel', '--https=8443', '--set-path=/github', 'off'],
      ['funnel', '--https=8443', '--set-path=/mcp', 'off'],
      ['funnel', '--https=8443', '--set-path=/voice', 'off'],
      ['funnel', '--https=8443', '--set-path=/hook', 'off'],
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/github', 'http://127.0.0.1:8789/github'],
      ['serve', '--tcp=8790', 'off'],
    ])
  })

  test('the owner\'s own handlers are never touched: nothing on 443, and a TCP forward of the meeting port to somewhere else stays', () => {
    const owners = { ...serving({ port: 443, paths: { '/mcp': 'http://127.0.0.1:3000/mcp' } }), TCP: { 443: { HTTPS: true }, 8790: { TCPForward: '127.0.0.1:9999' } } }
    assert.deepEqual(plan(none, owners, { to: 'off' }).run, [])
  })

  test('a handler on 8443 that Kage did not make stops every public route, because Funnel would make that handler public too', () => {
    const p = plan(all, serving({ paths: { '/app': 'http://127.0.0.1:3000' }, tcp: MEETING }))
    assert.deepEqual(p.foreign, ['/app'])
    assert.equal(p.run.some(a => a[0] === 'funnel'), false)
  })

  test('with Funnel not allowed, the public routes wait and the tailnet route still opens', () => {
    const p = plan(all, {}, { funnel: false })
    assert.deepEqual(p.run, [['serve', '--bg', '--yes', '--tcp=8790', 'tcp://127.0.0.1:8790']])
    assert.equal(p.waitsForFunnel, true)
  })

  test('off closes every route Kage made and only those', () => {
    assert.deepEqual(plan(all, serving({ funnel: true, paths: KAGE, tcp: MEETING }), { to: 'off' }).run, [
      ['funnel', '--https=8443', '--set-path=/github', 'off'], ['funnel', '--https=8443', '--set-path=/mcp', 'off'],
      ['funnel', '--https=8443', '--set-path=/voice', 'off'], ['funnel', '--https=8443', '--set-path=/hook', 'off'],
      ['serve', '--tcp=8790', 'off'],
    ])
  })

  test('the state of each route is read from tailscale serve status: public, tailnet only, or closed', () => {
    const routes = tunnelRoutes(all)
    const state = (s: object) => routeStates(routes, s).map(r => `${r.route.name} ${r.state}`)
    const { '/hook': _, ...paths } = KAGE
    assert.deepEqual(state(serving({ funnel: true, paths, tcp: MEETING })), ['github internet', 'voice internet', 'hooks closed', 'meeting tailnet'])
    assert.deepEqual(state(serving({ paths })), ['github tailnet', 'voice tailnet', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state(serving({ funnel: true, port: 443, paths })), ['github closed', 'voice closed', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state({}), ['github closed', 'voice closed', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state(serving({ funnel: true, paths: { '/mcp': KAGE['/mcp'] } }))[1], 'voice closed')
  })

  test('the doctor shows each route with its public address, and names the one fix when Tailscale or a route is not ready', () => {
    const routes = tunnelRoutes({ ...all, secrets: { githubSecret: 's', meetingToken: 'm' } as Secrets })
    const up = serving({ funnel: true, paths: { '/github': KAGE['/github'] }, tcp: MEETING })
    const lines = (f: Partial<Parameters<typeof tunnelLines>[0]>) => tunnelLines({ provider: 'tailscale', installed: true, running: true, funnel: true, dns: `${HOST}.`, routes, status: up, ...f }).map(l => `${l.kind} ${l.text}`)
    assert.deepEqual(lines({}), [`ok github is public at https://${HOST}:8443/github`, 'fail hooks is closed. Run kage tunnel on.', `ok meeting is on your tailnet at ${HOST}:8790`])
    assert.deepEqual(lines({ running: false }), ['fail Tailscale is stopped, so github, hooks and meeting are closed. Run tailscale up, then kage tunnel on.'])
    assert.deepEqual(lines({ installed: false, running: false }), ['fail Tailscale is not installed, so github, hooks and meeting are closed. Install it from https://tailscale.com/download, then run kage tunnel on.'])
    assert.deepEqual(lines({ provider: undefined }), [])
    assert.deepEqual(lines({ funnel: false, status: serving({ tcp: MEETING }) }).slice(0, 2), [
      'fail github is closed: Funnel is not allowed for this machine. Run kage tunnel on for the link that allows it.',
      'fail hooks is closed: Funnel is not allowed for this machine. Run kage tunnel on for the link that allows it.'])
    assert.deepEqual(lines({ status: serving({ paths: { '/github': KAGE['/github'] }, tcp: MEETING }) })[0], 'fail github is on your tailnet only, and GitHub calls it from the internet. Allow Funnel for this machine in the Tailscale admin page, then run kage tunnel on.')
  })
})
