import { tunnelLines, tunnelRoutes } from '../../core/tunnel.ts'
import { settings } from '../home.ts'
import { tailscaleBin, tailscaleState } from '../tailscale.ts'
import type { Group } from './context.ts'

export const tunnel: Group = async () => {
  const s = settings()
  const provider = s.config.tunnel?.provider, routes = tunnelRoutes(s)
  if (provider !== 'tailscale' || !routes.length) return []
  const bin = tailscaleBin()
  const now = bin ? tailscaleState(bin) : { running: false, serve: {} }
  return tunnelLines({ provider, running: now.running, ...'dns' in now && { dns: now.dns }, routes, status: now.serve })
}
