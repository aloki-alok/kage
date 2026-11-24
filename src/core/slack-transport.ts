import type { Config, Secrets } from './config.ts'

type SlackTransportName = 'socket' | 'http'
type Settings = { config: Config; secrets: Secrets }

export const SLACK_PORT = 8796
export const SLACK_PATH = '/slack'
const SLACK_TARGET = `http://127.0.0.1:${SLACK_PORT}${SLACK_PATH}`

export const slackHttpUsable = ({ config, secrets }: Settings) => config.slack?.transport !== 'socket' && !!secrets.slack?.signing

export function slackTransport(s: Settings): SlackTransportName {
  const set = s.config.slack?.transport ?? 'auto'
  if (set !== 'auto') return set
  const tunnel = s.config.tunnel
  const routed = !!s.config.slack?.publicUrl || (tunnel?.provider === 'tailscale' && (tunnel.targets ?? []).includes(SLACK_TARGET))
  return routed && slackHttpUsable(s) ? 'http' : 'socket'
}
