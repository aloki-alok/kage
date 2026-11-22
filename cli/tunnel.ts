#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { ENV_FILE, settings } from './home.ts'
import { updateConfig } from '../runtime/config-files.ts'
import { tunnelLines, tunnelPlan, tunnelRecord, tunnelRoutes } from '../core/tunnel.ts'
import { render } from '../core/doctor.ts'
import { tailscaleBin, tailscaleRun, tailscaleState } from './tailscale.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const arg = process.argv[2] || 'on'
if (arg !== 'on' && arg !== 'off') die('Usage: kage tunnel [on|off]')
const to = arg as 'on' | 'off'
const bin = tailscaleBin() ?? die('Tailscale is not installed. Get it at https://tailscale.com/download, sign in, then run kage tunnel on again.')
const before = tailscaleState(bin)
if (!before.running) die('Tailscale is not running. Run tailscale up, then kage tunnel on again.')
const said = (e: unknown) => ['stdout', 'stderr'].map(k => String((e as Record<string, unknown>)[k] ?? '')).join('\n').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('Warning:'))
const funnelLink = () => {
  const check = ['--https=8443', '--set-path=/kage-funnel-check']
  try {
    execFileSync(bin, ['funnel', '--bg', '--yes', ...check, 'http://127.0.0.1:9'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 })
    return undefined
  } catch (e) { return said(e).find(l => l.startsWith('https://')) } finally {
    try { tailscaleRun(bin, ['funnel', ...check, 'off']) } catch { }
  }
}

const s = settings()
const plan = tunnelPlan(s, { funnel: before.funnel, status: before.serve }, to)
const failed: string[] = []
for (const args of plan.run) {
  try { tailscaleRun(bin, args) } catch (e) { failed.push(`tailscale ${args.join(' ')}: ${said(e).join(' ') || (e as Error).message}`) }
}
if (plan.foreign.length) failed.push(`Port 8443 holds ${plan.foreign.join(', ')}, which Kage did not make. Funnel would make it public too, so Kage's public routes stay closed. Move it to another port, then run kage tunnel on again.`)
if (plan.waitsForFunnel && !plan.foreign.length) {
  const link = funnelLink()
  failed.push(`Funnel is not allowed for this machine, so the public routes stay closed. Allow it${link ? ` at ${link}` : ' in the Tailscale admin page'}, then run kage tunnel on again.`)
}
const now = tailscaleState(bin), wanted = to === 'on' ? tunnelRoutes(s) : [], routes = tunnelRecord(s, now.serve, to)
updateConfig(ENV_FILE, c => ({ ...c, tunnel: { provider: to === 'on' ? 'tailscale' : 'off', ...Object.keys(routes).length && { routes } } }))
const left = to === 'off' ? Object.keys(routes) : []
for (const p of left) failed.push(`Kage could not close ${p} on port 8443. Run tailscale serve --https=8443 --set-path=${p} off.`)

for (const line of tunnelLines({ provider: 'tailscale', installed: true, ...now, routes: wanted, status: now.serve })) console.log(render(line))
if (to === 'off' && !left.length) console.log('Every Kage route is closed.')
else if (!wanted.length) console.log('No connector that is on needs a route. Run kage tunnel on again after you turn one on.')
for (const f of failed) console.error(f)
process.exit(failed.length ? 1 : 0)
