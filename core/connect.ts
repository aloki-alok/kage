import type { Config, Secrets } from './config.ts'
import type { Line } from './doctor.ts'

export type ConnectorName = 'github' | 'browser' | 'email' | 'voice' | 'whatsapp' | 'meeting'
type ConnectorState = { state: 'on' } | { state: 'off' } | { state: 'unset'; missing: string[]; partial: boolean }

const need = (settings: [string, unknown][], turnedOff = false): ConnectorState => {
  const missing = settings.filter(([, v]) => !v).map(([k]) => k)
  return turnedOff ? { state: 'off' } : missing.length ? { state: 'unset', missing, partial: missing.length < settings.length } : { state: 'on' }
}

export function connectorStates({ config, secrets }: { config: Config; secrets: Secrets }): Record<ConnectorName, ConnectorState> {
  const c = config.connectors ?? {}
  return {
    github: need([['connectors.github.login', c.github?.login], ['githubToken', secrets.githubToken || secrets.githubSecret]]),
    browser: need([['browserToken', secrets.browserToken]]),
    email: need([['connectors.email.address', c.email?.address], ['connectors.email.queue', c.email?.queue], ['connectors.email.ownerEmail', c.email?.ownerEmail]], c.email?.on === false),
    voice: need([['voiceToken', secrets.voiceToken]], c.voice?.on === false),
    whatsapp: need([['waha.WAHA_API_KEY', secrets.waha?.WAHA_API_KEY]], c.whatsapp?.on === false),
    meeting: need([['meetingToken', secrets.meetingToken]]),
  }
}

const WALKED: ConnectorName[] = ['github', 'browser']
const DOCS: Record<ConnectorName, string> = { github: 'Voice and calls', browser: 'Voice and calls', email: 'Email', voice: 'Voice and calls', whatsapp: 'WhatsApp', meeting: 'Voice and calls' }
const and = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function connectorStep(name: ConnectorName, s: ConnectorState): string {
  if (s.state === 'on') return ''
  if (s.state === 'off') return `run kage connect ${name} to turn it back on`
  if (WALKED.includes(name)) return `run kage connect ${name}`
  const secret = s.missing.every(k => !k.startsWith('connectors.'))
  return `needs ${and(s.missing)}${secret ? ' in secrets.json' : ': kage set <key> <value>'} (docs/settings.md, "${DOCS[name]}")`
}

export const connectLines = (states: Record<ConnectorName, ConnectorState>) =>
  Object.entries(states).map(([name, s]) => `${s.state.padEnd(7)}${name.padEnd(10)}${connectorStep(name as ConnectorName, s)}`.trimEnd())

export const OFF_NOTES: Partial<Record<ConnectorName, string>> = {
  browser: 'The extension stays in Chrome until you remove it at chrome://extensions.',
  email: 'The SES receiving rule and the SQS queue stay in AWS until you delete them there.',
  voice: 'Its public route stays open until you run kage tunnel on.',
  whatsapp: 'The WAHA bridge keeps running in Docker until you stop its container.',
}

export const halfSetLines = (states: Record<ConnectorName, ConnectorState>): Line[] =>
  Object.entries(states).flatMap(([name, s]) => s.state === 'unset' && s.partial ? [{ kind: 'fail' as const, text: `${name} is half set up: ${connectorStep(name as ConnectorName, s)}` }] : [])
