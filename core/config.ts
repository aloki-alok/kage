// Kage's settings as typed data: config.json (settings) and secrets.json (tokens), and the fixed table that
// moves a flat env file into them and back. Pure: the files are read and written in runtime/config-files.ts.
import { z } from 'zod'
import { validName } from './gate.ts'
import { appEntry, validUserId, type Entry } from './registry.ts'

// The Claude models a setting or a tool may name, and the one a helper job (AFK, a guard, the dream job, a kagelet) uses when
// its own model setting is empty. A full id (claude-...) is also accepted where a model is typed into a file.
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const DEFAULT_MODEL = 'sonnet'

export type Env = Record<string, string>

const text = z.string().nullable().optional()
const count = z.number().int().nonnegative().optional()
const money = z.number().nonnegative().nullable().optional()
const yes = z.boolean().optional()
const strings = z.array(z.string()).optional()

// One schema for config.json. Strict, so a typo such as "maxSesion" is refused with its name instead of ignored.
// A key that is absent means the default, as an absent env line did.
export const Config = z.strictObject({
  version: z.literal(1),
  name: z.string().optional(),
  harness: z.strictObject({ runtime: text, route: text, cwd: text, memory: text, ownerMemory: text, maxSessions: count, idleMinutes: count }).optional(),
  people: z.strictObject({
    teammates: z.array(z.string().refine(validUserId)).optional(),
    agents: z.array(z.strictObject({ app: z.string(), owner: z.string().optional(), tag: z.string().optional() }).refine(a => appEntry(agentLine(a)) !== undefined)).optional(),
  }).optional(),
  kagelets: z.strictObject({
    max: count, dailyUsd: money, totalDailyUsd: money, chainUsd: money,
    dbRead: z.strictObject({ command: text, maxRows: count }).optional(),
  }).optional(),
  // Keys that stay out of every session's environment: the hub adds each to requests for its one host (runtime/key-proxy.ts, #182).
  sessionKeys: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.strictObject({
    host: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/), header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).optional(), prefix: z.string().optional(),
  })).optional(),
  autoUpdate: yes,
  afk: z.strictObject({ on: yes, model: text }).optional(),
  jev: z.strictObject({ agents: strings, threshold: money, model: text, url: text }).optional(),
  connectors: z.strictObject({
    email: z.strictObject({ on: yes, address: text, queue: text, ownerEmail: text, region: text, teammateEmails: strings }).optional(),
    voice: z.strictObject({ on: yes, port: count, max: count, perHour: count, model: text }).optional(),
    call: z.strictObject({ command: text }).optional(),
    github: z.strictObject({ login: text, port: count, perHour: count }).optional(),
    meeting: z.strictObject({ port: count, perHour: count, agentApi: text, agentId: count }).optional(),
    browser: z.strictObject({ port: count, block: strings }).optional(),
    whatsapp: z.strictObject({ on: yes, memory: text, model: text, wahaUrl: text, hookHost: text, hookPort: count }).optional(),
    commands: z.record(z.string().regex(/^\/[a-z][a-z0-9-]{1,30}$/), z.string().regex(/^\/\S+$/)).optional(),
  }).optional(),
  // Env lines the table does not know. A secret-looking one keeps only its name here (null) and its value in secrets.json.
  unknown: z.record(z.string(), z.string().nullable()).optional(),
})
export type Config = z.infer<typeof Config>
export type KeyRoute = NonNullable<Config['sessionKeys']>[string]

const sec = z.string().nullable().optional()
export const Secrets = z.strictObject({
  slack: z.strictObject({ app: sec, user: sec, bot: sec }).optional(),
  aws: z.strictObject({ accessKeyId: sec, secretAccessKey: sec }).optional(),
  voiceToken: sec, githubSecret: sec, meetingToken: sec, browserToken: sec, jevKey: sec, voiceAgentKey: sec,
  cartesiaKey: sec,   // compat: remove after 2026-12-15 (Cartesia speech is gone; an old secrets.json still holds it, and the schema is strict)
  // Values of env lines the table does not know and whose names look like secrets: kept, never dropped.
  unknown: z.record(z.string(), z.string()).optional(),
})
export type Secrets = z.infer<typeof Secrets>

type Agent = { app: string; owner?: string; tag?: string }
const agentLine = (a: Agent) => [a.app, a.owner, a.tag].filter(x => x !== undefined).join(':')

// How one env value becomes JSON and back. read gives undefined for a value that does not fit, and the line then goes to "unknown".
type Codec = { read: (v: string) => unknown; write: (x: any) => string }
const str: Codec = { read: v => v, write: String }
const int: Codec = { read: v => (/^\d+$/.test(v) ? Number(v) : undefined), write: String }
const num: Codec = { read: v => (/^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined), write: String }
const onoff: Codec = { read: v => (v === 'on' ? true : v === 'off' ? false : undefined), write: (b: boolean) => (b ? 'on' : 'off') }
const items = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean)
const list: Codec = { read: items, write: (a: string[]) => a.join(',') }
const people: Codec = { read: v => (items(v).every(validUserId) ? items(v) : undefined), write: (a: string[]) => a.join(',') }
const agents: Codec = {
  read: v => {
    const es = items(v).map(appEntry)
    return es.every(Boolean) ? es.map(e => ({ app: e!.id, ...(e!.owner && { owner: e!.owner }), ...(e!.tag && { tag: e!.tag }) })) : undefined
  },
  write: (a: Agent[]) => a.map(agentLine).join(','),
}
const commands: Codec = {
  read: v => {
    const pairs = items(v).map(e => /^(\/[a-z][a-z0-9-]{1,30})=(\/\S+)$/.exec(e))
    return pairs.every(Boolean) && new Set(pairs.map(m => m![1])).size === pairs.length ? Object.fromEntries(pairs.map(m => [m![1], m![2]])) : undefined
  },
  write: (o: Record<string, string>) => Object.entries(o).map(([k, p]) => `${k}=${p}`).join(','),
}

// The fixed table: env name, where it lives (config.json, or secrets.json when secret), its codec. Everything about a
// setting is on its row. Same input, same output: no model reads an env file (it holds tokens).
type Row = { env: string; path: string; codec: Codec; secret?: true }
const R = (env: string, path: string, codec: Codec = str, secret?: true): Row => ({ env, path, codec, ...(secret && { secret }) })
export const KEYS: Row[] = [
  R('KAGE_NAME', 'name'),
  R('KAGE_RUNTIME', 'harness.runtime'), R('KAGE_ROUTE', 'harness.route'), R('KAGE_CWD', 'harness.cwd'), R('KAGE_MEMORY', 'harness.memory'),
  R('KAGE_OWNER_MEMORY', 'harness.ownerMemory'), R('KAGE_MAX_SESSIONS', 'harness.maxSessions', int), R('KAGE_IDLE_MINUTES', 'harness.idleMinutes', int),
  R('KAGE_TEAMMATES', 'people.teammates', people), R('KAGE_TRUSTED_APPS', 'people.agents', agents),
  R('KAGE_MAX_KAGELETS', 'kagelets.max', int), R('KAGE_KAGELET_DAILY_USD', 'kagelets.dailyUsd', num),
  R('KAGE_KAGELET_TOTAL_DAILY_USD', 'kagelets.totalDailyUsd', num), R('KAGE_KAGELET_CHAIN_USD', 'kagelets.chainUsd', num),
  R('KAGE_DB_READ_COMMAND', 'kagelets.dbRead.command'), R('KAGE_DB_READ_MAX_ROWS', 'kagelets.dbRead.maxRows', int),
  R('KAGE_AUTO_UPDATE', 'autoUpdate', onoff),
  R('KAGE_AFK', 'afk.on', onoff), R('KAGE_AFK_MODEL', 'afk.model'),
  R('KAGE_JEV_AGENTS', 'jev.agents', list), R('KAGE_JEV_THRESHOLD', 'jev.threshold', num), R('KAGE_JEV_MODEL', 'jev.model'),
  R('KAGE_EMAIL', 'connectors.email.on', onoff), R('KAGE_MAIL_ADDRESS', 'connectors.email.address'), R('KAGE_MAIL_QUEUE', 'connectors.email.queue'),
  R('KAGE_OWNER_EMAIL', 'connectors.email.ownerEmail'), R('KAGE_AWS_REGION', 'connectors.email.region'), R('KAGE_TEAMMATE_EMAILS', 'connectors.email.teammateEmails', list),
  R('KAGE_VOICE', 'connectors.voice.on', onoff), R('KAGE_VOICE_PORT', 'connectors.voice.port', int), R('KAGE_VOICE_MAX', 'connectors.voice.max', int),
  R('KAGE_VOICE_PER_HOUR', 'connectors.voice.perHour', int), R('KAGE_VOICE_MODEL', 'connectors.voice.model'), R('KAGE_CALL_COMMAND', 'connectors.call.command'),
  R('KAGE_GITHUB_LOGIN', 'connectors.github.login'), R('KAGE_GITHUB_PORT', 'connectors.github.port', int), R('KAGE_GITHUB_PER_HOUR', 'connectors.github.perHour', int),
  R('KAGE_MEETING_PORT', 'connectors.meeting.port', int), R('KAGE_MEETING_PER_HOUR', 'connectors.meeting.perHour', int), R('KAGE_MEETING_AGENT_API', 'connectors.meeting.agentApi'), R('KAGE_MEETING_AGENT_ID', 'connectors.meeting.agentId', int),
  R('KAGE_BROWSER_PORT', 'connectors.browser.port', int), R('KAGE_BROWSER_BLOCK', 'connectors.browser.block', list),
  R('KAGE_WHATSAPP', 'connectors.whatsapp.on', onoff), R('KAGE_WA_MEMORY', 'connectors.whatsapp.memory'), R('KAGE_WA_MODEL', 'connectors.whatsapp.model'),
  R('KAGE_WAHA_URL', 'connectors.whatsapp.wahaUrl'), R('KAGE_WA_HOOK_HOST', 'connectors.whatsapp.hookHost'), R('KAGE_WA_HOOK_PORT', 'connectors.whatsapp.hookPort', int),
  R('KAGE_COMMANDS', 'connectors.commands', commands),
  R('SLACK_APP_TOKEN', 'slack.app', str, true), R('SLACK_USER_TOKEN', 'slack.user', str, true), R('SLACK_BOT_TOKEN', 'slack.bot', str, true),
  R('KAGE_AWS_ACCESS_KEY_ID', 'aws.accessKeyId', str, true), R('KAGE_AWS_SECRET_ACCESS_KEY', 'aws.secretAccessKey', str, true),
  R('KAGE_VOICE_TOKEN', 'voiceToken', str, true), R('KAGE_GITHUB_SECRET', 'githubSecret', str, true), R('KAGE_MEETING_TOKEN', 'meetingToken', str, true),
  R('KAGE_BROWSER_TOKEN', 'browserToken', str, true), R('JEV_API_KEY', 'jevKey', str, true), R('KAGE_VOICE_AGENT_KEY', 'voiceAgentKey', str, true),
]
// Old names that older env files may still hold. The new name wins when both are there.
export const ALIASES: Record<string, string> = { KAGE_MAX_SPECIALISTS: 'KAGE_MAX_KAGELETS', KAGE_SPECIALIST_DAILY_USD: 'KAGE_KAGELET_DAILY_USD' }
// Names the grep in docs/settings.md finds that are not settings: Kage sets them, or a script or test does.
export const NOT_SETTINGS = ['KAGE_BIN', 'KAGE_CALL_CODE', 'KAGE_CALL_REASON', 'KAGE_CLAUDE', 'KAGE_DIR', 'KAGE_ENV', 'KAGE_GIT_URL', 'KAGE_KEYS_SOCK', 'KAGE_KEYS_TOKEN', 'KAGE_MEETBOT_HUB', 'KAGE_MEETBOT_PIPELINE', 'KAGE_MEETBOT_PIPELINE_KEY', 'KAGE_MEETBOT_TOKEN', 'KAGE_PANE_SETTINGS', 'KAGE_REF', 'KAGE_SESSION', 'KAGE_SETUP_WAIT', 'KAGE_SLACK_API', 'KAGE_SSM_SOCK', 'KAGE_SSM_TOKEN', 'KAGE_TARBALL', 'KAGE_THREAD']

// By its name, or by what it holds: a URL with user:password@ in it, or a long unbroken random-looking string (not a path).
const looksSecret = (name: string, value = '') => /TOKEN|SECRET|KEY|PASS|AUTH|CRED/i.test(name) || /:\/\/[^\s/:@]+:[^\s/@]+@/.test(value)
  || (/^[A-Za-z0-9_+/=.-]{32,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && !/^[/~.]/.test(value))

const put = (o: Record<string, any>, path: string, v: unknown) => {
  const ks = path.split('.')
  const last = ks.pop()!
  for (const k of ks) o = (o[k] ??= {})
  o[last] = v
}
const get = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o)

// A flat env, as parseEnv reads it, to the two files' contents. A line that does not fit its type, or that the table
// does not know, goes under "unknown" and is never lost: toEnv gives it back. A secret-looking one has its value in secrets.json.
export function fromEnv(env: Env): { config: Config; secrets: Secrets } {
  const config: Record<string, any> = { version: 1 }
  const secrets: Record<string, any> = {}
  const unknown: Record<string, string | null> = {}
  const secretUnknown: Record<string, string> = {}
  const flat: Env = { ...env }
  for (const [old, now] of Object.entries(ALIASES)) if (old in flat) { if (!(now in flat)) flat[now] = flat[old]!; delete flat[old] }
  const known = new Map(KEYS.map(k => [k.env, k]))
  for (const [name, value] of Object.entries(flat).sort(([a], [b]) => a.localeCompare(b))) {
    const row = known.get(name)
    const v = row?.codec.read(value)
    if (row && v !== undefined) put(row.secret ? secrets : config, row.path, v)
    else if (looksSecret(name, value)) { unknown[name] = null; secretUnknown[name] = value }
    else unknown[name] = value
  }
  if (Object.keys(unknown).length) config.unknown = unknown
  if (Object.keys(secretUnknown).length) secrets.unknown = secretUnknown
  return { config: Config.parse(config), secrets: Secrets.parse(secrets) }
}

// The two files' contents back to a flat env: every value the files hold, in the form the env file held it.
export function toEnv(config: Config, secrets: Secrets): Env {
  const env: Env = {}
  for (const k of KEYS) {
    const v = get(k.secret ? secrets : config, k.path)
    if (v !== undefined && v !== null) env[k.env] = k.codec.write(v)
  }
  for (const [name, value] of Object.entries(config.unknown ?? {})) if (value !== null) env[name] = value
  for (const [name, value] of Object.entries(secrets.unknown ?? {})) env[name] = value
  return env
}

// The names of the env lines an import could not place, for the owner's DM. Names only, never values.
export const unknownNames = (config: Config) => Object.keys(config.unknown ?? {}).sort()

// What differs between two loads of the files: JSON paths only, never values. people.* applies to a running hub; the rest waits for a restart.
const leaves = (o: unknown, prefix: string, out: Map<string, string>) => {
  if (o !== null && typeof o === 'object' && !Array.isArray(o) && prefix !== 'people.agents') for (const [k, v] of Object.entries(o)) leaves(v, prefix ? `${prefix}.${k}` : k, out)
  else out.set(prefix, JSON.stringify(o))
}
export function diff(before: { config: Config; secrets: Secrets }, after: { config: Config; secrets: Secrets }): { live: string[]; restart: string[] } {
  const a = new Map<string, string>(), b = new Map<string, string>()
  for (const [side, m] of [[before, a], [after, b]] as const) { leaves(side.config, '', m); leaves(side.secrets, 'secrets', m) }
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort()
  return { live: changed.filter(k => k.startsWith('people.')), restart: changed.filter(k => !k.startsWith('people.')) }
}

// config.people as the registry's entries and back (core/registry.ts), so kage add and remove edit the JSON.
export const registryOf = (c: Config): Entry[] => [
  ...(c.people?.teammates ?? []).map(id => ({ kind: 'person' as const, id })),
  ...(c.people?.agents ?? []).map(a => ({ kind: 'agent' as const, id: a.app, ...(a.owner && { owner: a.owner }), ...(a.tag && { tag: a.tag }) })),
]
export const withRegistry = (c: Config, entries: Entry[]): Config => ({
  ...c,
  people: {
    teammates: [...new Set(entries.filter(e => e.kind === 'person').map(e => e.id))],
    agents: entries.flatMap(e => (e.kind === 'agent' ? [{ app: e.id, ...(e.owner && { owner: e.owner }), ...(e.tag && { tag: e.tag }) }] : [])),
  },
})

// "~" and "~/x" in a path setting, as the home folder.
export const tilde = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p)

// What hub.ts and the listeners would exit or crash on, so a bad value is refused before it is the file the hub restarts on.
export function badValue(c: Config): string | undefined {
  for (const [path, v] of [['harness.memory', c.harness?.memory], ['harness.ownerMemory', c.harness?.ownerMemory], ['harness.cwd', c.harness?.cwd], ['connectors.whatsapp.memory', c.connectors?.whatsapp?.memory]] as const)
    if (v && /['"\\]/.test(v)) return `${path} must not hold a quote or a backslash`
  const k = c.connectors
  for (const [path, v] of [['voice.port', k?.voice?.port], ['github.port', k?.github?.port], ['meeting.port', k?.meeting?.port], ['browser.port', k?.browser?.port], ['whatsapp.hookPort', k?.whatsapp?.hookPort]] as const)
    if (v != null && !(Number.isInteger(v) && v >= 1024 && v <= 65535)) return `connectors.${path} must be a port from 1024 to 65535`
}
// What the hub needs to run: the three Slack tokens, a valid name, and the people lists as the strings the Slack
// connector takes ("<app>:<owner>:<tag>"). The schema already refused a wrong list entry, so nothing else is checked here.
export function checkSettings(c: Config, s: Secrets): { name: string; teammates: string[]; apps: string[] } | { error: string } {
  for (const [path, v] of [['slack.app', s.slack?.app], ['slack.user', s.slack?.user], ['slack.bot', s.slack?.bot]] as const) if (!v) return { error: `${path} is missing in secrets.json` }
  const bad = badValue(c)
  if (bad) return { error: bad }
  const name = (c.name || 'kage').toLowerCase()
  if (!validName(name)) return { error: `name "${name}" must be a short lowercase word (letters, digits, dashes)` }
  return { name, teammates: c.people?.teammates ?? [], apps: (c.people?.agents ?? []).map(agentLine) }
}

// What a session may change through set_setting. safe: applies at once. power: grants reach or runs code, so the owner says yes
// on a card first. never: not settable that way. A key not listed is power, so a new key starts closed.
const SAFE = [/^kagelets\.(max|dailyUsd|totalDailyUsd|chainUsd)$/, /^afk\.(on|model)$/, /^jev\.(threshold|model)$/,
  /^connectors\.(voice|github|meeting|browser|whatsapp)\.(port|max|perHour|hookPort)$/, /^connectors\.whatsapp\.model$/]
export function settingTier(key: string): 'safe' | 'power' | 'never' {
  const parts = key.split('.')
  if (!key || parts.some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p)) || ['secrets', 'version', 'unknown'].includes(parts[0]!)) return 'never'
  return SAFE.some(r => r.test(key)) ? 'safe' : 'power'
}
