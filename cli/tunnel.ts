#!/usr/bin/env node
import { ENV_FILE, settings } from './home.ts'
import { updateConfig } from '../runtime/config-files.ts'
import { tailscaleArgs, tunnelLines, tunnelRoutes } from '../core/tunnel.ts'
import { render } from '../core/doctor.ts'
import { execFileSync } from 'node:child_process'
import { tailscaleBin, tailscaleRun, tailscaleState } from './tailscale.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const to = process.argv[2] || 'on'
if (to !== 'on' && to !== 'off') die('Usage: kage tunnel [on|off]')
const bin = tailscaleBin() ?? die('Tailscale is not installed. Get it at https://tailscale.com/download, sign in, then run kage tunnel on again.')
const before = tailscaleState(bin)
if (!before.running) die('Tailscale is not running. Run tailscale up, then kage tunnel on again.')
const said = (e: unknown) => ['stdout', 'stderr'].map(k => String((e as Record<string, unknown>)[k] ?? '')).join('\n').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('Warning:'))
const funnelLink = () => {
  try { execFileSync(bin, ['funnel', '--bg', '--yes', '--https=443', '--set-path=/kage-funnel-check', 'http://127.0.0.1:9'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 }) } catch (e) { return said(e).find(l => l.startsWith('https://')) }
  return undefined
}

const s = settings()
const wanted = to === 'on' ? tunnelRoutes(s) : []
const failed: string[] = []
for (const route of tunnelRoutes(s, { all: true })) {
  const keep = wanted.find(w => w.name === route.name)
  if (keep?.reach === 'internet' && !before.funnel) continue
  for (const args of tailscaleArgs(keep ?? route, keep ? 'on' : 'off')) {
    try { tailscaleRun(bin, args) } catch (e) { if (keep) failed.push(`${route.name}: ${said(e).join(' ') || (e as Error).message}`) }
  }
}
if (wanted.some(r => r.reach === 'internet') && !before.funnel) {
  const link = funnelLink()
  failed.push(`Funnel is not allowed for this machine, so the public routes stay closed. Allow it${link ? ` at ${link}` : ' in the Tailscale admin page'}, then run kage tunnel on again.`)
}
updateConfig(ENV_FILE, c => ({ ...c, tunnel: { ...c.tunnel, provider: to === 'on' ? 'tailscale' : 'off' } }))

const now = tailscaleState(bin)
for (const line of tunnelLines({ provider: 'tailscale', ...now, routes: wanted, status: now.serve })) console.log(render(line))
if (to === 'off') console.log('Every Kage route is closed.')
else if (!wanted.length) console.log('No connector that is on needs a route. Run kage tunnel on again after you turn one on.')
for (const f of failed) console.error(f)
process.exit(failed.length ? 1 : 0)
