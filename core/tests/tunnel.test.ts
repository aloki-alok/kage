import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { routeStates, tunnelLines, tunnelPlan, tunnelRecord, tunnelRoutes } from '../tunnel.ts'
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
const owning = <T extends { config: Config }>(s: T, routes: Record<string, string> = KAGE): T => ({ ...s, config: { ...s.config, tunnel: { targets: Object.values(routes) } } })
const plan = (s: typeof all, status: object, o: { funnel?: boolean; to?: 'on' | 'off' } = {}) => tunnelPlan(s, { funnel: o.funnel ?? true, status }, o.to ?? 'on')
const set = (a: string[]) => new Set(a)
const OFF = (p: string) => ['serve', '--https=8443', `--set-path=${p}`, 'off']

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
    assert.deepEqual(plan(owning(all), serving({ funnel: true, paths: KAGE, tcp: MEETING })).run, [])
  })

  test('a route of a connector turned off since is closed, even a hook whose port is now unset, and a route that moved port is opened again', () => {
    const moved = { ...KAGE, '/github': 'http://127.0.0.1:9100/github' }
    const stale = serving({ funnel: true, paths: moved, tcp: MEETING })
    assert.deepEqual(plan(owning({ config: { connectors: { github: { login: 'me' } } } as Config, secrets: { githubSecret: 's' } as Secrets }, moved), stale).run, [
      OFF('/github'), OFF('/mcp'), OFF('/voice'), OFF('/hook'),
      ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/github', 'http://127.0.0.1:8789/github'],
      ['serve', '--tcp=8790', 'off'],
    ])
  })

  test('the owner\'s own handlers are never touched: nothing on 443, a TCP forward of the meeting port to somewhere else, or their own /mcp on 8443', () => {
    const owners = { ...serving({ port: 443, paths: { '/mcp': 'http://127.0.0.1:3000/mcp' } }), TCP: { 443: { HTTPS: true }, 8790: { TCPForward: '127.0.0.1:9999' } } }
    assert.deepEqual(plan(none, owners, { to: 'off' }).run, [])
    const theirs = serving({ paths: { '/mcp': 'http://127.0.0.1:8787/mcp' } })
    assert.deepEqual(plan(none, theirs, { to: 'off' }).run, [])
    assert.deepEqual(plan(all, theirs).foreign, ['/mcp'])
  })

  test('a handler on 8443 that Kage did not make stops every opening, because Funnel would make it public too, but Kage still closes its own', () => {
    const p = plan(owning(none, { '/github': KAGE['/github'] }), serving({ funnel: true, paths: { '/app': 'http://127.0.0.1:3000', '/github': KAGE['/github'] } }), { to: 'off' })
    assert.deepEqual([p.foreign, p.run], [['/app'], [OFF('/github')]])
    assert.equal(plan(all, serving({ paths: { '/app': 'http://127.0.0.1:3000' }, tcp: MEETING })).run.some(a => a[0] === 'funnel'), false)
  })

  test('a route with the right handler but Funnel turned off for the port is opened again, and a leftover check route is always closed', () => {
    const p = plan(owning(all), serving({ paths: { ...KAGE, '/kage-funnel-check': 'http://127.0.0.1:9' }, tcp: MEETING }))
    assert.deepEqual(p.run[0], OFF('/kage-funnel-check'))
    assert.equal(p.run.filter(a => a[0] === 'funnel').length, 4)
  })

  test('what Kage records as its own is what it serves now: each wanted path, and an old one it failed to close', () => {
    const now = serving({ funnel: true, paths: { '/github': KAGE['/github'], '/hook': KAGE['/hook'], '/app': 'http://127.0.0.1:3000', '/kage-funnel-check': 'http://127.0.0.1:9' } })
    const s = owning({ config: { connectors: { github: { login: 'me' } } } as Config, secrets: { githubSecret: 's' } as Secrets }, { '/hook': KAGE['/hook'] })
    assert.deepEqual(set(tunnelRecord(s, now, { '/github': KAGE['/github'] })), set([KAGE['/github'], KAGE['/hook']]))
    assert.deepEqual(tunnelRecord(s, now, {}), [KAGE['/hook']])
  })

  test('a handler the owner made is never recorded as Kage\'s, even when it points where Kage would', () => {
    const theirs = serving({ paths: { '/mcp': KAGE['/mcp'] } })
    assert.deepEqual(tunnelRecord(all, theirs, {}), [])
  })

  test('a target Kage made claims only the path it was made for, never the owner\'s handler on another path that points there', () => {
    const s = owning({ config: { connectors: { github: { login: 'me' } } } as Config, secrets: { githubSecret: 's' } as Secrets }, { '/github': KAGE['/github'] })
    const now = serving({ funnel: true, paths: { '/github': KAGE['/github'], '/mcp': KAGE['/github'] } })
    assert.deepEqual(plan(s, now).foreign, ['/mcp'])
    assert.deepEqual(plan(s, now, { to: 'off' }).run, [OFF('/github')])
    assert.deepEqual(tunnelRecord(s, now, {}), [KAGE['/github']])
  })

  test('when Tailscale\'s state cannot be read after a run, the record keeps what Kage owned and what it set out to open', () => {
    const s = owning(none, { '/hook': KAGE['/hook'] })
    assert.deepEqual(set(tunnelRecord(s, undefined, { '/github': KAGE['/github'] })), set([KAGE['/hook'], KAGE['/github']]))
  })

  test('a path that moved port keeps its old target in the record until a read shows it gone, so a crash mid-move still lets off close it', () => {
    const moved = 'http://127.0.0.1:9100/github'
    const record = tunnelRecord(owning(none, { '/github': KAGE['/github'] }), undefined, { '/github': moved })
    assert.deepEqual(set(record), set([KAGE['/github'], moved]))
    const s = { ...none, config: { ...none.config, tunnel: { targets: record } } }
    const old = serving({ funnel: true, paths: { '/github': KAGE['/github'] } })
    assert.deepEqual(plan(s, old, { to: 'off' }).run, [OFF('/github')])
    assert.deepEqual(tunnelRecord(s, serving({ funnel: true, paths: { '/github': moved } }), {}), [moved])
  })

  test('the plan names each path it opens with its target, so Kage records them before it runs', () => {
    assert.deepEqual(plan(all, {}).opens, { '/github': KAGE['/github'], '/mcp': KAGE['/mcp'], '/voice': KAGE['/voice'], '/hook': KAGE['/hook'] })
    assert.deepEqual(plan(all, {}, { funnel: false }).opens, {})
  })

  test('with Funnel not allowed, the public routes wait and the tailnet route still opens', () => {
    const p = plan(all, {}, { funnel: false })
    assert.deepEqual(p.run, [['serve', '--bg', '--yes', '--tcp=8790', 'tcp://127.0.0.1:8790']])
    assert.equal(p.waitsForFunnel, true)
  })

  test('off closes every route Kage made and only those, with serve so no Funnel check stands in the way', () => {
    assert.deepEqual(plan(owning(all), serving({ funnel: true, paths: KAGE, tcp: MEETING }), { to: 'off' }).run, [
      OFF('/github'), OFF('/mcp'), OFF('/voice'), OFF('/hook'), ['serve', '--tcp=8790', 'off'],
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
