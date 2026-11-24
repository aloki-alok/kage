import type { Config, Secrets } from './config.ts'

type SlackTransportName = 'socket' | 'http'
type Settings = { config: Config; secrets: Secrets }
type SlackRequest = { kind: 'challenge'; challenge: string } | { kind: 'dispatch'; name: string; body: object; event?: object }

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

const objectOf = (text: string): Record<string, any> | undefined => {
  try { const v = JSON.parse(text); return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined } catch { return undefined }
}

export function slackRequest(contentType: string, body: string): SlackRequest | undefined {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'application/json') {
    const p = objectOf(body)
    if (p?.type === 'url_verification' && typeof p.challenge === 'string') return { kind: 'challenge', challenge: p.challenge }
    const event = p?.type === 'event_callback' && p.event !== null && typeof p.event === 'object' ? p.event : undefined
    return p && typeof event?.type === 'string' && event.type ? { kind: 'dispatch', name: event.type, body: p, event } : undefined
  }
  if (type !== 'application/x-www-form-urlencoded') return undefined
  const form = new URLSearchParams(body)
  const payload = form.get('payload')
  if (payload !== null) { const p = objectOf(payload); return p && { kind: 'dispatch', name: 'interactive', body: p } }
  return form.get('command') ? { kind: 'dispatch', name: 'slash_commands', body: Object.fromEntries(form) } : undefined
}
