import type { Config, Secrets } from './config.ts'
import type { Line } from './doctor.ts'
import { smsProvider } from './sms.ts'

export type ConnectorName = 'github' | 'browser' | 'email' | 'voice' | 'siri' | 'whatsapp' | 'meeting' | 'sms'
type ConnectorState = { state: 'on' } | { state: 'off' } | { state: 'unset'; missing: string[]; partial: boolean }

const need = (settings: [string, unknown][], turnedOff = false): ConnectorState => {
  const missing = settings.filter(([, v]) => !v).map(([k]) => k)
  return turnedOff ? { state: 'off' } : missing.length ? { state: 'unset', missing, partial: missing.length < settings.length } : { state: 'on' }
}

export function connectorStates({ config, secrets }: { config: Config; secrets: Secrets }): Record<ConnectorName, ConnectorState> {
  const c = config.connectors ?? {}
  return {
    github: need([['connectors.github.app.id', c.github?.app], ['connectors.github.login', c.github?.login], ['connectors.github.userId', c.github?.userId], ['githubAppKey', secrets.githubAppKey], ['githubSecret', secrets.githubSecret]]),
    browser: need([['browserToken', secrets.browserToken]]),
    email: need([['connectors.email.address', c.email?.address], ['connectors.email.queue', c.email?.queue], ['connectors.email.ownerEmail', c.email?.ownerEmail]], c.email?.on === false),
    voice: need([['voiceToken', secrets.voiceToken]], c.voice?.on === false),
    siri: need([['siriToken', secrets.siriToken]], c.siri?.on === false),
    whatsapp: need([['waha.WAHA_API_KEY', secrets.waha?.WAHA_API_KEY], ['waha.WHATSAPP_HOOK_HMAC_KEY', secrets.waha?.WHATSAPP_HOOK_HMAC_KEY]], c.whatsapp?.on === false),
    meeting: need([['meetingToken', secrets.meetingToken]]),
    sms: need([['connectors.sms.from', c.sms?.from], ['connectors.sms.publicUrl', c.sms?.publicUrl], ...smsKeys(c.sms, secrets)], c.sms?.on === false),
  }
}

const smsKeys = (sms: NonNullable<Config['connectors']>['sms'], secrets: Secrets): [string, unknown][] => smsProvider(sms) === 'twilio'
  ? [['connectors.sms.accountSid', sms?.accountSid], ['twilioAuthToken', secrets.twilioAuthToken]]
  : [['connectors.sms.telnyxPublicKey', sms?.telnyxPublicKey], ['telnyxApiKey', secrets.telnyxApiKey]]

const WALKED: ConnectorName[] = ['github', 'browser']
const DOCS: Record<ConnectorName, string> = { github: 'Voice and calls', browser: 'Voice and calls', email: 'Email', voice: 'Voice and calls', siri: 'Ask Kage from Siri', whatsapp: 'WhatsApp', meeting: 'Voice and calls', sms: 'SMS' }
const and = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function connectorStep(name: ConnectorName, s: ConnectorState): string {
  if (s.state === 'on') return ''
  if (s.state === 'off') return `run kage connector on ${name} to turn it back on`
  if (WALKED.includes(name)) return `run kage connector on ${name}`
  return `needs ${and(s.missing)}: run kage connector on ${name} in a terminal to be asked (docs/settings.md, "${DOCS[name]}")`
}

export const connectLines = (states: Record<ConnectorName, ConnectorState>) =>
  Object.entries(states).map(([name, s]) => `${s.state.padEnd(7)}${name.padEnd(10)}${connectorStep(name as ConnectorName, s)}`.trimEnd())

export const OFF_NOTES: Partial<Record<ConnectorName, string>> = {
  browser: 'The extension stays in Chrome until you remove it at chrome://extensions.',
  email: 'The SES receiving rule and the SQS queue stay in AWS until you delete them there.',
  voice: 'Its public route stays open until you run kage tunnel on.',
  siri: 'Its tailnet route stays open until you run kage tunnel on. Your Shortcut keeps the token until you delete it.',
  whatsapp: 'The WAHA bridge keeps running in Docker until you stop its container.',
  sms: "The number keeps its webhook at your provider until you change it there.",
}

export const halfSetLines = (states: Record<ConnectorName, ConnectorState>): Line[] =>
  Object.entries(states).flatMap(([name, s]) => s.state === 'unset' && s.partial ? [{ kind: 'fail' as const, text: `${name} is half set up: ${connectorStep(name as ConnectorName, s)}` }] : [])

export type Ask = { key: string; question: string; kind: 'plain' | 'secret' | 'made'; show?: boolean; choices?: string[]; check?: (value: string) => string | undefined }

const e164 = (v: string) => /^\+[1-9]\d{6,14}$/.test(v) ? undefined : 'Type the number in E.164: a plus, the country code and the number, like +14155550100.'
const ASKS: Record<string, Omit<Ask, 'key'>[]> = {
  'connectors.email.address': [{ kind: 'plain', question: 'Which address do people write to, to reach Kage?' }],
  'connectors.email.queue': [{ kind: 'plain', question: "The SQS queue URL that receives that address's mail:" }],
  'connectors.email.ownerEmail': [{ kind: 'plain', question: 'Your own email address (Kage replies only to its domain):' }],
  voiceToken: [{ kind: 'made', show: true, question: 'the voice agent sends it as Authorization: Bearer <token>' }],
  siriToken: [{ kind: 'made', show: true, question: 'the Siri Shortcut sends it as Authorization: Bearer <token>' }],
  meetingToken: [{ kind: 'made', show: true, question: 'post each transcript with Authorization: Bearer <token>' }],
  'waha.WAHA_API_KEY': [{ kind: 'made', question: 'the WhatsApp bridge API key, written to its container at each start' }],
  'waha.WHATSAPP_HOOK_HMAC_KEY': [{ kind: 'made', question: 'the key that signs what the WhatsApp bridge posts to Kage' }],
  'connectors.sms.from': [{ kind: 'plain', question: 'The number Kage texts from, like +14155550100:', check: e164 }],
  'connectors.sms.publicUrl': [{ kind: 'plain', question: 'The public URL that reaches Kage for texts, ending in /sms:', check: v => /^https:\/\/\S+\/sms$/.test(v) ? undefined : 'Type an https URL that ends in /sms.' }],
  'connectors.sms.accountSid': [{ kind: 'plain', question: 'Your Twilio account SID (it starts with AC):' }],
  twilioAuthToken: [{ kind: 'secret', question: 'Your Twilio auth token:' }],
  'connectors.sms.telnyxPublicKey': [{ kind: 'plain', question: 'The Telnyx public key that signs its webhooks (Keys and Credentials):' }],
  telnyxApiKey: [{ kind: 'secret', question: 'Your Telnyx API key:' }],
}

export const connectAsks = (missing: string[]): Ask[] =>
  missing.flatMap(key => (ASKS[key] ?? []).map(a => ({ key, ...a })))

const oneOf = (choices: string[]) => (v: string) => choices.includes(v) ? undefined : `Type ${choices.join(' or ')}.`

export function choiceAsk(name: ConnectorName, config: Config): Ask | undefined {
  if (name !== 'sms' || config.connectors?.sms?.provider) return undefined
  const choices = ['telnyx', 'twilio']
  return { key: 'connectors.sms.provider', kind: 'plain', choices, question: `Which SMS provider sends Kage's texts (${choices.join(' or ')})?`, check: oneOf(choices) }
}
