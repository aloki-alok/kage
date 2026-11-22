import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { routeStates, tailscaleArgs, tunnelLines, tunnelRoutes } from '../tunnel.ts'
import type { Config, Secrets } from '../config.ts'

const HOST = 'box.tail1.ts.net'
const all = { config: { connectors: { github: { login: 'me' }, voice: {}, meeting: {} }, tripwires: { hookPort: 8792 } } as Config,
  secrets: { githubSecret: 's', voiceToken: 'v', meetingToken: 'm' } as Secrets }
const serving = (o: { funnel?: boolean; paths?: Record<string, string>; tcp?: Record<string, object> }) => ({
  TCP: { ...o.paths && { 443: { HTTPS: true } }, ...o.tcp },
  ...o.paths && { Web: { [`${HOST}:443`]: { Handlers: Object.fromEntries(Object.entries(o.paths).map(([p, to]) => [p, { Proxy: to }])) } } },
  ...o.funnel && { AllowFunnel: { [`${HOST}:443`]: true } },
})

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

  test('every route Kage could have opened, at its set port, so a connector turned off since loses its route too', () => {
    const none = { config: { connectors: { github: { port: 9100 } }, tripwires: {} } as Config, secrets: {} as Secrets }
    assert.deepEqual(tunnelRoutes(none, { all: true }).map(r => `${r.name}:${r.port}`), ['github:9100', 'voice:8787', 'meeting:8790'])
  })

  test('a public route is a funnel on 443 by path that keeps the path; a tailnet route is a serve of its own port; off undoes each', () => {
    const [github, voice, , meeting] = tunnelRoutes(all)
    assert.deepEqual(tailscaleArgs(github!, 'on'), [['funnel', '--bg', '--yes', '--https=443', '--set-path=/github', 'http://127.0.0.1:8789/github']])
    assert.deepEqual(tailscaleArgs(voice!, 'off'), [['funnel', '--https=443', '--set-path=/mcp', 'off'], ['funnel', '--https=443', '--set-path=/voice', 'off']])
    assert.deepEqual(tailscaleArgs(meeting!, 'on'), [['serve', '--bg', '--yes', '--tcp=8790', 'tcp://127.0.0.1:8790']])
    assert.deepEqual(tailscaleArgs(meeting!, 'off'), [['serve', '--tcp=8790', 'off']])
  })

  test('the state of each route is read from tailscale serve status: public, tailnet only, or closed', () => {
    const routes = tunnelRoutes(all)
    const state = (s: object) => routeStates(routes, s).map(r => `${r.route.name} ${r.state}`)
    const paths = { '/github': 'http://127.0.0.1:8789/github', '/mcp': 'http://127.0.0.1:8787/mcp', '/voice': 'http://127.0.0.1:8787/voice' }
    assert.deepEqual(state(serving({ funnel: true, paths, tcp: { 8790: { TCPForward: '127.0.0.1:8790' } } })), ['github internet', 'voice internet', 'hooks closed', 'meeting tailnet'])
    assert.deepEqual(state(serving({ paths })), ['github tailnet', 'voice tailnet', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state(serving({ funnel: true, paths: { '/github': 'http://127.0.0.1:9999/github' } })), ['github closed', 'voice closed', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state({}), ['github closed', 'voice closed', 'hooks closed', 'meeting closed'])
    assert.deepEqual(state(serving({ funnel: true, paths: { '/mcp': 'http://127.0.0.1:8787/mcp' } }))[1], 'voice closed')
  })

  test('the doctor shows each route with its public address, and names the one fix when Tailscale or a route is not ready', () => {
    const routes = tunnelRoutes({ ...all, secrets: { githubSecret: 's', meetingToken: 'm' } as Secrets })
    const up = serving({ funnel: true, paths: { '/github': 'http://127.0.0.1:8789/github' }, tcp: { 8790: { TCPForward: '127.0.0.1:8790' } } })
    const lines = (f: Partial<Parameters<typeof tunnelLines>[0]>) => tunnelLines({ provider: 'tailscale', running: true, dns: `${HOST}.`, routes, status: up, ...f }).map(l => `${l.kind} ${l.text}`)
    assert.deepEqual(lines({}), [`ok github is public at https://${HOST}/github`, 'fail hooks is closed. Run kage tunnel on.', `ok meeting is on your tailnet at ${HOST}:8790`])
    assert.deepEqual(lines({ running: false }), ['fail Tailscale is stopped, so github, hooks and meeting are closed. Run tailscale up, then kage tunnel on.'])
    assert.deepEqual(lines({ provider: undefined }), [])
    assert.deepEqual(lines({ status: serving({ paths: { '/github': 'http://127.0.0.1:8789/github' }, tcp: { 8790: { TCPForward: '127.0.0.1:8790' } } }) })[0], 'fail github is on your tailnet only, and GitHub calls it from the internet. Allow Funnel for this machine in the Tailscale admin page, then run kage tunnel on.')
  })
})
