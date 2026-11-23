type PluginCall = { args: string[]; region: string; target: string }

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const PROFILE = /^[\w.@+=,-]{0,128}$/
const TARGET = /^(i|mi)-[0-9a-f]{8,17}$/

const parse = (s: string): Record<string, unknown> | undefined => {
  try { const v: unknown = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined } catch { return undefined }
}
const isAt = (url: unknown, scheme: string, host: (region: string) => string[], region: string) => {
  if (typeof url !== 'string') return false
  try { const u = new URL(url); return u.protocol === scheme && !u.username && !u.password && !u.port && host(region).includes(u.hostname) } catch { return false }
}
const hosts = (service: string) => (region: string) => [`${service}.${region}.amazonaws.com`, `${service}.${region}.amazonaws.com.cn`]

export function startSessionCall(args: unknown): PluginCall | { error: string } {
  if (!Array.isArray(args) || args.length !== 6 || args.some(a => typeof a !== 'string')) return { error: 'expected six arguments' }
  const [response, region, operation, profile, parameters, endpoint] = args as string[]
  if (operation !== 'StartSession') return { error: 'only StartSession is relayed' }
  if (!REGION.test(region!)) return { error: 'region is not an AWS region name' }
  if (!PROFILE.test(profile!)) return { error: 'profile name has odd characters' }
  const session = parse(response!)
  if (!session || !isAt(session.StreamUrl, 'wss:', hosts('ssmmessages'), region!)) return { error: 'the stream host is not ssmmessages for this region' }
  if (!isAt(endpoint, 'https:', hosts('ssm'), region!)) return { error: 'the endpoint is not ssm for this region' }
  const wanted = parse(parameters!)
  if (typeof wanted?.Target !== 'string') return { error: 'parameters name no Target' }
  const target = TARGET.test(wanted.Target) ? wanted.Target : 'other'
  return { args: args as string[], region: region!, target }
}

export const ssmEligible = (key: string) => /^(dm|[CDG][A-Z0-9]+:\d+\.\d+)(#side-.+)?$/.test(key) && !/#side-k?dream(-|$)/.test(key)
