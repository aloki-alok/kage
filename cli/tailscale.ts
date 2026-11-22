import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const MAC_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

export function tailscaleBin(): string | undefined {
  try { execFileSync('tailscale', ['version'], { stdio: 'ignore', timeout: 10_000 }); return 'tailscale' } catch { return existsSync(MAC_APP) ? MAC_APP : undefined }
}

export const tailscaleRun = (bin: string, args: string[]) =>
  execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })

export function tailscaleState(bin: string): { running: boolean; dns?: string; serve: unknown } {
  const json = (args: string[]) => { try { return JSON.parse(tailscaleRun(bin, args) || '{}') } catch { return {} } }
  const status = json(['status', '--json']) as { BackendState?: string; Self?: { DNSName?: string } }
  return { running: status.BackendState === 'Running', dns: status.Self?.DNSName, serve: json(['serve', 'status', '--json']) }
}
