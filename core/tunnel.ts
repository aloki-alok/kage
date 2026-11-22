import type { Config, Secrets } from './config.ts'
import type { Line } from './doctor.ts'

type TunnelRoute = { name: 'github' | 'voice' | 'hooks' | 'meeting'; port: number; paths: string[]; reach: 'internet' | 'tailnet' }
type RouteState = 'internet' | 'tailnet' | 'closed'
type ServeStatus = {
  TCP?: Record<string, { TCPForward?: string }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}

const PUBLIC_PORT = 443
const local = (port: number) => `127.0.0.1:${port}`

export function tunnelRoutes({ config, secrets }: { config: Config; secrets: Secrets }, o: { all?: boolean } = {}): TunnelRoute[] {
  const c = config.connectors, t = config.tripwires, on = (x: boolean) => o.all || x
  const routes: (TunnelRoute | false)[] = [
    on(!!secrets.githubSecret && !!c?.github?.login) && { name: 'github', port: c?.github?.port || 8789, paths: ['/github'], reach: 'internet' },
    on(!!secrets.voiceToken && c?.voice?.on !== false) && { name: 'voice', port: c?.voice?.port || 8787, paths: ['/mcp', '/voice'], reach: 'internet' },
    !!t?.hookPort && on(t.on !== false) && { name: 'hooks', port: t.hookPort, paths: ['/hook'], reach: 'internet' },
    on(!!secrets.meetingToken) && { name: 'meeting', port: c?.meeting?.port || 8790, paths: [], reach: 'tailnet' },
  ]
  return routes.filter(r => r !== false)
}

export function tailscaleArgs(r: TunnelRoute, to: 'on' | 'off'): string[][] {
  if (r.reach === 'tailnet') return [to === 'on' ? ['serve', '--bg', '--yes', `--tcp=${r.port}`, `tcp://${local(r.port)}`] : ['serve', `--tcp=${r.port}`, 'off']]
  return r.paths.map(p => to === 'on'
    ? ['funnel', '--bg', '--yes', `--https=${PUBLIC_PORT}`, `--set-path=${p}`, `http://${local(r.port)}${p}`]
    : ['funnel', `--https=${PUBLIC_PORT}`, `--set-path=${p}`, 'off'])
}

export function routeStates(routes: TunnelRoute[], status: unknown) {
  const s = (status ?? {}) as ServeStatus
  const web = Object.entries(s.Web ?? {}).find(([host]) => host.endsWith(`:${PUBLIC_PORT}`))
  const funnel = !!web && s.AllowFunnel?.[web[0]] === true
  const state = (r: TunnelRoute): RouteState => {
    if (r.reach === 'tailnet') return s.TCP?.[r.port]?.TCPForward === local(r.port) ? 'tailnet' : 'closed'
    const served = r.paths.every(p => web?.[1].Handlers?.[p]?.Proxy === `http://${local(r.port)}${p}`)
    return !served ? 'closed' : funnel ? 'internet' : 'tailnet'
  }
  return routes.map(route => ({ route, state: state(route) }))
}

const list = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function tunnelLines(f: { provider?: 'tailscale' | 'off'; running: boolean; funnel: boolean; dns?: string; routes: TunnelRoute[]; status: unknown }): Line[] {
  if (f.provider !== 'tailscale' || !f.routes.length) return []
  if (!f.running) return [{ kind: 'fail', text: `Tailscale is stopped, so ${list(f.routes.map(r => r.name))} ${f.routes.length > 1 ? 'are' : 'is'} closed. Run tailscale up, then kage tunnel on.` }]
  const host = (f.dns ?? '').replace(/\.$/, '')
  return routeStates(f.routes, f.status).map(({ route: r, state }): Line =>
    state === 'closed' && r.reach === 'internet' && !f.funnel ? { kind: 'fail', text: `${r.name} is closed: Funnel is not allowed for this machine. Run kage tunnel on for the link that allows it.` }
    : state === 'closed' ? { kind: 'fail', text: `${r.name} is closed. Run kage tunnel on.` }
    : r.reach === 'tailnet' ? { kind: 'ok', text: `${r.name} is on your tailnet at ${host}:${r.port}` }
    : state === 'tailnet' ? { kind: 'fail', text: `${r.name} is on your tailnet only, and ${r.name === 'github' ? 'GitHub calls it' : 'its caller is'} from the internet. Allow Funnel for this machine in the Tailscale admin page, then run kage tunnel on.` }
    : { kind: 'ok', text: `${r.name} is public at https://${host}${r.paths[0]}` })
}
