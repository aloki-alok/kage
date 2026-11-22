#!/usr/bin/env node
import { ENV_FILE, settings } from './home.ts'
import { updateConfig } from '../runtime/config-files.ts'
import { tailscaleArgs, tunnelLines, tunnelRoutes } from '../core/tunnel.ts'
import { render } from '../core/doctor.ts'
import { tailscaleBin, tailscaleRun, tailscaleState } from './tailscale.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const to = process.argv[2] || 'on'
if (to !== 'on' && to !== 'off') die('Usage: kage tunnel [on|off]')
const bin = tailscaleBin() ?? die('Tailscale is not installed. Get it at https://tailscale.com/download, sign in, then run kage tunnel on again.')
if (!tailscaleState(bin).running) die('Tailscale is not running. Run tailscale up, then kage tunnel on again.')

const s = settings()
const wanted = to === 'on' ? tunnelRoutes(s) : []
const failed: string[] = []
for (const route of tunnelRoutes(s, { all: true })) {
  const keep = wanted.find(w => w.name === route.name)
  for (const args of tailscaleArgs(keep ?? route, keep ? 'on' : 'off')) {
    try { tailscaleRun(bin, args) } catch (e) {
      if (keep) failed.push(`${route.name}: ${String((e as { stderr?: string }).stderr || (e as Error).message).split('\n').filter(l => l && !l.startsWith('Warning:')).join(' ')}`)
    }
  }
}
updateConfig(ENV_FILE, c => ({ ...c, tunnel: { ...c.tunnel, provider: to === 'on' ? 'tailscale' : 'off' } }))

const now = tailscaleState(bin)
for (const line of tunnelLines({ provider: 'tailscale', running: now.running, dns: now.dns, routes: wanted, status: now.serve })) console.log(render(line))
if (to === 'off') console.log('Every Kage route is closed.')
else if (!wanted.length) console.log('No connector that is on needs a route. Run kage tunnel on again after you turn one on.')
for (const f of failed) console.error(f)
process.exit(failed.length ? 1 : 0)
