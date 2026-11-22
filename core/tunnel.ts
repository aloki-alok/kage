import type { Config, Secrets } from './config.ts'
import type { Line } from './doctor.ts'

type TunnelRoute = { name: 'github' | 'voice' | 'hooks' | 'meeting'; port: number; paths: string[]; reach: 'internet' | 'tailnet' }
type RouteState = 'internet' | 'tailnet' | 'closed'
type ServeStatus = {
  TCP?: Record<string, { TCPForward?: string }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}

const PUBLIC_PORT = 8443
const OWN_PATHS = ['/github', '/mcp', '/voice', '/hook']
const local = (port: number) => `127.0.0.1:${port}`
const target = (port: number, path: string) => `http://${local(port)}${path}`
const kageWeb = (s: ServeStatus) => Object.entries(s.Web ?? {}).find(([host]) => host.endsWith(`:${PUBLIC_PORT}`))

export function tunnelRoutes({ config, secrets }: { config: Config; secrets: Secrets }): TunnelRoute[] {
  const c = config.connectors, t = config.tripwires
  const routes: (TunnelRoute | false)[] = [
    !!secrets.githubSecret && !!c?.github?.login && { name: 'github', port: c.github.port || 8789, paths: ['/github'], reach: 'internet' },
    !!secrets.voiceToken && c?.voice?.on !== false && { name: 'voice', port: c?.voice?.port || 8787, paths: ['/mcp', '/voice'], reach: 'internet' },
    !!t?.hookPort && t.on !== false && { name: 'hooks', port: t.hookPort, paths: ['/hook'], reach: 'internet' },
    !!secrets.meetingToken && { name: 'meeting', port: c?.meeting?.port || 8790, paths: [], reach: 'tailnet' },
  ]
  return routes.filter(r => r !== false)
}

const CHECK_PATH = '/kage-funnel-check'

function served(settings: { config: Config; secrets: Secrets }, status: unknown, to: 'on' | 'off') {
  const s = (status ?? {}) as ServeStatus, web = kageWeb(s), handlers = web?.[1].Handlers ?? {}
  const recorded = settings.config.tunnel?.routes ?? {}
  const wanted = to === 'on' ? tunnelRoutes(settings) : []
  const want = new Map(wanted.flatMap(r => r.reach === 'internet' ? r.paths.map(p => [p, target(r.port, p)] as const) : []))
  const owned = (p: string, h: { Proxy?: string }) => p === CHECK_PATH || (OWN_PATHS.includes(p) && recorded[p] === h.Proxy)
  return { s, handlers, want, wanted, owned, funnelOn: !!web && s.AllowFunnel?.[web[0]] === true }
}

export function tunnelPlan(settings: { config: Config; secrets: Secrets }, now: { funnel: boolean; status: unknown }, to: 'on' | 'off') {
  const { s, handlers, want, wanted, owned, funnelOn } = served(settings, now.status, to)
  const foreign = Object.entries(handlers).filter(([p, h]) => !owned(p, h)).map(([p]) => p)
  const close = Object.entries(handlers).filter(([p, h]) => owned(p, h) && want.get(p) !== h.Proxy).map(([p]) => ['serve', `--https=${PUBLIC_PORT}`, `--set-path=${p}`, 'off'])
  const open = foreign.length || !now.funnel ? [] : [...want].filter(([p, t]) => handlers[p]?.Proxy !== t || !funnelOn)
    .map(([p, t]) => ['funnel', '--bg', '--yes', `--https=${PUBLIC_PORT}`, `--set-path=${p}`, t])
  const meetingPort = settings.config.connectors?.meeting?.port || 8790, meetingWanted = wanted.some(r => r.name === 'meeting')
  const forwarded = s.TCP?.[meetingPort]?.TCPForward === local(meetingPort)
  const tcp = meetingWanted && !forwarded ? [['serve', '--bg', '--yes', `--tcp=${meetingPort}`, `tcp://${local(meetingPort)}`]]
    : !meetingWanted && forwarded ? [['serve', `--tcp=${meetingPort}`, 'off']] : []
  return { run: [...close, ...open, ...tcp], foreign, waitsForFunnel: !now.funnel && want.size > 0 }
}

export function tunnelRecord(settings: { config: Config; secrets: Secrets }, status: unknown, to: 'on' | 'off'): Record<string, string> {
  const { handlers, want, owned } = served(settings, status, to)
  return Object.fromEntries(Object.entries(handlers).filter(([p, h]) => p !== CHECK_PATH && (want.get(p) === h.Proxy || owned(p, h))).map(([p, h]) => [p, h.Proxy!]))
}

export function routeStates(routes: TunnelRoute[], status: unknown) {
  const s = (status ?? {}) as ServeStatus
  const web = kageWeb(s)
  const funnel = !!web && s.AllowFunnel?.[web[0]] === true
  const state = (r: TunnelRoute): RouteState => {
    if (r.reach === 'tailnet') return s.TCP?.[r.port]?.TCPForward === local(r.port) ? 'tailnet' : 'closed'
    const served = r.paths.every(p => web?.[1].Handlers?.[p]?.Proxy === target(r.port, p))
    return !served ? 'closed' : funnel ? 'internet' : 'tailnet'
  }
  return routes.map(route => ({ route, state: state(route) }))
}

const list = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function tunnelLines(f: { provider?: 'tailscale' | 'off'; installed: boolean; running: boolean; funnel: boolean; dns?: string; routes: TunnelRoute[]; status: unknown }): Line[] {
  if (f.provider !== 'tailscale' || !f.routes.length) return []
  const closed = `${list(f.routes.map(r => r.name))} ${f.routes.length > 1 ? 'are' : 'is'} closed`
  if (!f.installed) return [{ kind: 'fail', text: `Tailscale is not installed, so ${closed}. Install it from https://tailscale.com/download, then run kage tunnel on.` }]
  if (!f.running) return [{ kind: 'fail', text: `Tailscale is stopped, so ${closed}. Run tailscale up, then kage tunnel on.` }]
  const host = (f.dns ?? '').replace(/\.$/, '')
  return routeStates(f.routes, f.status).map(({ route: r, state }): Line =>
    state === 'closed' && r.reach === 'internet' && !f.funnel ? { kind: 'fail', text: `${r.name} is closed: Funnel is not allowed for this machine. Run kage tunnel on for the link that allows it.` }
    : state === 'closed' ? { kind: 'fail', text: `${r.name} is closed. Run kage tunnel on.` }
    : r.reach === 'tailnet' ? { kind: 'ok', text: `${r.name} is on your tailnet at ${host}:${r.port}` }
    : state === 'tailnet' ? { kind: 'fail', text: `${r.name} is on your tailnet only, and ${r.name === 'github' ? 'GitHub calls it' : 'its caller is'} from the internet. Allow Funnel for this machine in the Tailscale admin page, then run kage tunnel on.` }
    : { kind: 'ok', text: `${r.name} is public at https://${host}:${PUBLIC_PORT}${r.paths[0]}` })
}
