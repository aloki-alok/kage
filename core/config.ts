import { z } from 'zod'
import { validName } from './gate.ts'
import { appEntry, validUserId, type Entry } from './registry.ts'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const DEFAULT_MODEL = 'sonnet'

export type Env = Record<string, string>

const text = z.string().nullable().optional()
const count = z.number().int().nonnegative().optional()
const money = z.number().nonnegative().nullable().optional()
const yes = z.boolean().optional()
const strings = z.array(z.string()).optional()

export const Config = z.strictObject({
  version: z.literal(1),
  name: z.string().optional(),
  harness: z.strictObject({ runtime: text, route: text, cwd: text, memory: text, ownerMemory: text, maxSessions: count, idleMinutes: count, jobModel: text, jobFreshEvery: count, jobCarry: count, jobCarryChars: count, jobLaneDefault: yes, sandbox: yes, pluginsOff: strings }).optional(),
  people: z.strictObject({
    teammates: z.array(z.string().refine(validUserId)).optional(),
    trusted: z.array(z.string().refine(validUserId)).optional(),
    agents: z.array(z.strictObject({ app: z.string(), owner: z.string().optional(), tag: z.string().optional() }).refine(a => appEntry(agentLine(a)) !== undefined)).optional(),
  }).refine(p => (p.trusted ?? []).every(id => p.teammates?.includes(id)), { message: 'every trusted id must also be in people.teammates' }).optional(),
  waiting: z.strictObject({ expireHours: count }).optional(),
  kagelets: z.strictObject({
    max: count, ownersMax: count, dailyUsd: money, totalDailyUsd: money, chainUsd: money, needsPerDay: count, askRunsPerHour: count, notesKept: count, noteChars: count, measureMinutes: count, trendRuns: count,
    release: z.enum(['rules', 'review']).optional(), reviewsPerDay: count, reviewModel: text,
    dbRead: z.strictObject({ command: text, maxRows: count }).optional(),
  }).optional(),
  sessionKeys: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.strictObject({
    host: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/), header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).optional(), prefix: z.string().optional(),
  })).optional(),
  autoUpdate: yes,
  sharedTools: strings,
  afk: z.strictObject({ on: yes, model: text }).optional(),
  jev: z.strictObject({ agents: strings, threshold: money, model: text, url: text, ackWords: yes }).optional(),
  telemetry: z.strictObject({ on: yes, endpoint: text }).optional(),
  tripwires: z.strictObject({ on: yes, timeoutSec: count, maxKb: count, failPing: count, patternMax: count, lineMax: count, maxPosts: count, catchUpMax: count, seenMax: count, hookPort: count, hookHost: text, hookPerHour: count, env: strings, swapAfter: count, shadowWindowMin: count, swapUndoDays: count }).optional(),
  connectors: z.strictObject({
    email: z.strictObject({ on: yes, address: text, queue: text, ownerEmail: text, region: text, teammateEmails: strings }).optional(),
    voice: z.strictObject({ on: yes, port: count, max: count, perHour: count, model: text }).optional(),
    call: z.strictObject({ command: text }).optional(),
    github: z.strictObject({ login: text, port: count, perHour: count }).optional(),
    meeting: z.strictObject({ port: count, perHour: count, agentApi: text, agentId: count }).optional(),
    browser: z.strictObject({ port: count, block: strings }).optional(),
    whatsapp: z.strictObject({ on: yes, memory: text, model: text, wahaUrl: text, hookHost: text, hookPort: count, checkMinutes: count }).optional(),
    commands: z.record(z.string().regex(/^\/[a-z][a-z0-9-]{1,30}$/), z.string().regex(/^\/\S+$/)).optional(),
  }).optional(),
  unknown: z.record(z.string(), z.string().nullable()).optional(),
})
export type Config = z.infer<typeof Config>
export type KeyRoute = NonNullable<Config['sessionKeys']>[string]

const sec = z.string().nullable().optional()
export const Secrets = z.strictObject({
  slack: z.strictObject({ app: sec, user: sec, bot: sec }).optional(),
  aws: z.strictObject({ accessKeyId: sec, secretAccessKey: sec }).optional(),
  voiceToken: sec, githubSecret: sec, meetingToken: sec, browserToken: sec, jevKey: sec, voiceAgentKey: sec, claudeToken: sec,
  waha: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).optional(),
  cartesiaKey: sec,   // compat: remove after 2026-12-15 (Cartesia speech is gone; an old secrets.json still holds it, and the schema is strict)
  unknown: z.record(z.string(), z.string()).optional(),
})
export type Secrets = z.infer<typeof Secrets>

type Agent = { app: string; owner?: string; tag?: string }
const agentLine = (a: Agent) => [a.app, a.owner, a.tag].filter(x => x !== undefined).join(':')

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

type Row = { env: string; path: string; codec: Codec; secret?: true }
const R = (env: string, path: string, codec: Codec = str, secret?: true): Row => ({ env, path, codec, ...(secret && { secret }) })
export const KEYS: Row[] = [
  R('KAGE_NAME', 'name'),
  R('KAGE_RUNTIME', 'harness.runtime'), R('KAGE_ROUTE', 'harness.route'), R('KAGE_CWD', 'harness.cwd'), R('KAGE_MEMORY', 'harness.memory'),
  R('KAGE_TRIPWIRES_MAX_POSTS', 'tripwires.maxPosts', int), R('KAGE_TRIPWIRES_CATCH_UP_MAX', 'tripwires.catchUpMax', int), R('KAGE_TRIPWIRES_SEEN_MAX', 'tripwires.seenMax', int),
  R('KAGE_TRIPWIRES_HOOK_PORT', 'tripwires.hookPort', int), R('KAGE_TRIPWIRES_HOOK_HOST', 'tripwires.hookHost'), R('KAGE_TRIPWIRES_HOOK_PER_HOUR', 'tripwires.hookPerHour', int),
  R('KAGE_TRIPWIRES_SWAP_AFTER', 'tripwires.swapAfter', int), R('KAGE_TRIPWIRES_SHADOW_WINDOW_MIN', 'tripwires.shadowWindowMin', int), R('KAGE_TRIPWIRES_SWAP_UNDO_DAYS', 'tripwires.swapUndoDays', int), R('KAGE_WAITING_EXPIRE_HOURS', 'waiting.expireHours', int),
  R('KAGE_OWNER_MEMORY', 'harness.ownerMemory'), R('KAGE_MAX_SESSIONS', 'harness.maxSessions', int), R('KAGE_IDLE_MINUTES', 'harness.idleMinutes', int), R('KAGE_JOB_MODEL', 'harness.jobModel'), R('KAGE_JOB_FRESH_EVERY', 'harness.jobFreshEvery', int), R('KAGE_JOB_CARRY', 'harness.jobCarry', int), R('KAGE_JOB_CARRY_CHARS', 'harness.jobCarryChars', int), R('KAGE_JOB_LANE_DEFAULT', 'harness.jobLaneDefault', onoff), R('KAGE_SANDBOX', 'harness.sandbox', onoff), R('KAGE_PLUGINS_OFF', 'harness.pluginsOff', list),
  R('KAGE_TEAMMATES', 'people.teammates', people), R('KAGE_TRUSTED_PEOPLE', 'people.trusted', people), R('KAGE_TRUSTED_APPS', 'people.agents', agents),
  R('KAGE_MAX_KAGELETS', 'kagelets.max', int), R('KAGE_KAGELET_OWNERS_MAX', 'kagelets.ownersMax', int), R('KAGE_KAGELET_NEEDS_PER_DAY', 'kagelets.needsPerDay', int), R('KAGE_KAGELET_ASK_RUNS_PER_HOUR', 'kagelets.askRunsPerHour', int), R('KAGE_KAGELET_NOTES_KEPT', 'kagelets.notesKept', int), R('KAGE_KAGELET_NOTE_CHARS', 'kagelets.noteChars', int), R('KAGE_KAGELET_MEASURE_MINUTES', 'kagelets.measureMinutes', int), R('KAGE_KAGELET_TREND_RUNS', 'kagelets.trendRuns', int), R('KAGE_KAGELET_RELEASE', 'kagelets.release'), R('KAGE_KAGELET_REVIEWS_PER_DAY', 'kagelets.reviewsPerDay', int), R('KAGE_KAGELET_REVIEW_MODEL', 'kagelets.reviewModel'), R('KAGE_KAGELET_DAILY_USD', 'kagelets.dailyUsd', num),
  R('KAGE_KAGELET_TOTAL_DAILY_USD', 'kagelets.totalDailyUsd', num), R('KAGE_KAGELET_CHAIN_USD', 'kagelets.chainUsd', num),
  R('KAGE_DB_READ_COMMAND', 'kagelets.dbRead.command'), R('KAGE_DB_READ_MAX_ROWS', 'kagelets.dbRead.maxRows', int),
  R('KAGE_AUTO_UPDATE', 'autoUpdate', onoff), R('KAGE_SHARED_TOOLS', 'sharedTools', list),
  R('KAGE_AFK', 'afk.on', onoff), R('KAGE_AFK_MODEL', 'afk.model'),
  R('KAGE_JEV_AGENTS', 'jev.agents', list), R('KAGE_JEV_THRESHOLD', 'jev.threshold', num), R('KAGE_JEV_MODEL', 'jev.model'), R('KAGE_JEV_URL', 'jev.url'), R('KAGE_JEV_ACK_WORDS', 'jev.ackWords', onoff),
  R('KAGE_TRIPWIRES', 'tripwires.on', onoff), R('KAGE_TRIPWIRES_TIMEOUT_SEC', 'tripwires.timeoutSec', int), R('KAGE_TRIPWIRES_MAX_KB', 'tripwires.maxKb', int),
  R('KAGE_TRIPWIRES_FAIL_PING', 'tripwires.failPing', int), R('KAGE_TRIPWIRES_PATTERN_MAX', 'tripwires.patternMax', int), R('KAGE_TRIPWIRES_LINE_MAX', 'tripwires.lineMax', int),
  R('KAGE_TRIPWIRES_ENV', 'tripwires.env', list),
  R('KAGE_TELEMETRY', 'telemetry.on', onoff), R('KAGE_TELEMETRY_ENDPOINT', 'telemetry.endpoint'),
  R('KAGE_EMAIL', 'connectors.email.on', onoff), R('KAGE_MAIL_ADDRESS', 'connectors.email.address'), R('KAGE_MAIL_QUEUE', 'connectors.email.queue'),
  R('KAGE_OWNER_EMAIL', 'connectors.email.ownerEmail'), R('KAGE_AWS_REGION', 'connectors.email.region'), R('KAGE_TEAMMATE_EMAILS', 'connectors.email.teammateEmails', list),
  R('KAGE_VOICE', 'connectors.voice.on', onoff), R('KAGE_VOICE_PORT', 'connectors.voice.port', int), R('KAGE_VOICE_MAX', 'connectors.voice.max', int),
  R('KAGE_VOICE_PER_HOUR', 'connectors.voice.perHour', int), R('KAGE_VOICE_MODEL', 'connectors.voice.model'), R('KAGE_CALL_COMMAND', 'connectors.call.command'),
  R('KAGE_GITHUB_LOGIN', 'connectors.github.login'), R('KAGE_GITHUB_PORT', 'connectors.github.port', int), R('KAGE_GITHUB_PER_HOUR', 'connectors.github.perHour', int),
  R('KAGE_MEETING_PORT', 'connectors.meeting.port', int), R('KAGE_MEETING_PER_HOUR', 'connectors.meeting.perHour', int), R('KAGE_MEETING_AGENT_API', 'connectors.meeting.agentApi'), R('KAGE_MEETING_AGENT_ID', 'connectors.meeting.agentId', int),
  R('KAGE_BROWSER_PORT', 'connectors.browser.port', int), R('KAGE_BROWSER_BLOCK', 'connectors.browser.block', list),
  R('KAGE_WHATSAPP', 'connectors.whatsapp.on', onoff), R('KAGE_WA_MEMORY', 'connectors.whatsapp.memory'), R('KAGE_WA_MODEL', 'connectors.whatsapp.model'),
  R('KAGE_WAHA_URL', 'connectors.whatsapp.wahaUrl'), R('KAGE_WA_HOOK_HOST', 'connectors.whatsapp.hookHost'), R('KAGE_WA_HOOK_PORT', 'connectors.whatsapp.hookPort', int), R('KAGE_WA_CHECK_MINUTES', 'connectors.whatsapp.checkMinutes', int),
  R('KAGE_COMMANDS', 'connectors.commands', commands),
  R('SLACK_APP_TOKEN', 'slack.app', str, true), R('SLACK_USER_TOKEN', 'slack.user', str, true), R('SLACK_BOT_TOKEN', 'slack.bot', str, true),
  R('KAGE_AWS_ACCESS_KEY_ID', 'aws.accessKeyId', str, true), R('KAGE_AWS_SECRET_ACCESS_KEY', 'aws.secretAccessKey', str, true),
  R('KAGE_VOICE_TOKEN', 'voiceToken', str, true), R('KAGE_GITHUB_SECRET', 'githubSecret', str, true), R('KAGE_MEETING_TOKEN', 'meetingToken', str, true),
  R('KAGE_BROWSER_TOKEN', 'browserToken', str, true), R('JEV_API_KEY', 'jevKey', str, true), R('KAGE_VOICE_AGENT_KEY', 'voiceAgentKey', str, true), R('KAGE_CLAUDE_TOKEN', 'claudeToken', str, true),
]
export const ALIASES: Record<string, string> = { KAGE_MAX_SPECIALISTS: 'KAGE_MAX_KAGELETS', KAGE_SPECIALIST_DAILY_USD: 'KAGE_KAGELET_DAILY_USD' }
export const NOT_SETTINGS = ['KAGE_BIN', 'KAGE_CALL_CODE', 'KAGE_CALL_REASON', 'KAGE_CLAUDE', 'KAGE_DIR', 'KAGE_ENV', 'KAGE_GIT_URL', 'KAGE_KEYS_SOCK', 'KAGE_KEYS_TOKEN', 'KAGE_MEETBOT_HUB', 'KAGE_MEETBOT_PIPELINE', 'KAGE_MEETBOT_PIPELINE_KEY', 'KAGE_MEETBOT_TOKEN', 'KAGE_PANE_SETTINGS', 'KAGE_REF', 'KAGE_SESSION', 'KAGE_SETUP_WAIT', 'KAGE_SLACK_API', 'KAGE_SSM_SOCK', 'KAGE_SSM_TOKEN', 'KAGE_TARBALL', 'KAGE_THREAD']

const looksSecret = (name: string, value = '') => /TOKEN|SECRET|KEY|PASS|AUTH|CRED/i.test(name) || /:\/\/[^\s/:@]+:[^\s/@]+@/.test(value)
  || (/^[A-Za-z0-9_+/=.-]{32,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && !/^[/~.]/.test(value))

const put = (o: Record<string, any>, path: string, v: unknown) => {
  const ks = path.split('.')
  const last = ks.pop()!
  for (const k of ks) o = (o[k] ??= {})
  o[last] = v
}
const get = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o)

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

export function toEnv(config: Config, secrets: Secrets): Env {
  const env: Env = {}
  for (const k of KEYS) {
    const v = get(k.secret ? secrets : config, k.path)
    if (v !== undefined && v !== null) env[k.env] = k.codec.write(v)
  }
  return { ...env, ...unknownEnv(config, secrets) }
}

export function unknownEnv(config: Config, secrets: Secrets): Env {
  const env: Env = {}
  for (const [name, value] of Object.entries(config.unknown ?? {})) if (value !== null) env[name] = value
  for (const [name, value] of Object.entries(secrets.unknown ?? {})) env[name] = value
  return env
}

export const unknownNames = (config: Config) => Object.keys(config.unknown ?? {}).sort()

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

export const registryOf = (c: Config): Entry[] => [
  ...(c.people?.teammates ?? []).map(id => ({ kind: 'person' as const, id, ...c.people?.trusted?.includes(id) && { trusted: true as const } })),
  ...(c.people?.agents ?? []).map(a => ({ kind: 'agent' as const, id: a.app, ...(a.owner && { owner: a.owner }), ...(a.tag && { tag: a.tag }) })),
]
export const withRegistry = (c: Config, entries: Entry[]): Config => ({
  ...c,
  people: {
    teammates: [...new Set(entries.filter(e => e.kind === 'person').map(e => e.id))],
    ...entries.some(e => e.kind === 'person' && e.trusted) && { trusted: [...new Set(entries.flatMap(e => (e.kind === 'person' && e.trusted ? [e.id] : [])))] },
    agents: entries.flatMap(e => (e.kind === 'agent' ? [{ app: e.id, ...(e.owner && { owner: e.owner }), ...(e.tag && { tag: e.tag }) }] : [])),
  },
})

export const tilde = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p)

export function badValue(c: Config): string | undefined {
  for (const [path, v] of [['harness.memory', c.harness?.memory], ['harness.ownerMemory', c.harness?.ownerMemory], ['harness.cwd', c.harness?.cwd], ['connectors.whatsapp.memory', c.connectors?.whatsapp?.memory]] as const)
    if (v && /['"\\]/.test(v)) return `${path} must not hold a quote or a backslash`
  const k = c.connectors
  for (const [path, v] of [['voice.port', k?.voice?.port], ['github.port', k?.github?.port], ['meeting.port', k?.meeting?.port], ['browser.port', k?.browser?.port], ['whatsapp.hookPort', k?.whatsapp?.hookPort]] as const)
    if (v != null && !(Number.isInteger(v) && v >= 1024 && v <= 65535)) return `connectors.${path} must be a port from 1024 to 65535`
  const hook = c.tripwires?.hookPort
  if (hook && !(Number.isInteger(hook) && hook >= 1024 && hook <= 65535)) return 'tripwires.hookPort must be 0 (off) or a port from 1024 to 65535'
}
export function checkSettings(c: Config, s: Secrets): { name: string; teammates: string[]; trusted: string[]; apps: string[] } | { error: string } {
  for (const [path, v] of [['slack.app', s.slack?.app], ['slack.user', s.slack?.user], ['slack.bot', s.slack?.bot]] as const) if (!v) return { error: `${path} is missing in secrets.json` }
  const bad = badValue(c)
  if (bad) return { error: bad }
  const name = (c.name || 'kage').toLowerCase()
  if (!validName(name)) return { error: `name "${name}" must be a short lowercase word (letters, digits, dashes)` }
  return { name, teammates: c.people?.teammates ?? [], trusted: c.people?.trusted ?? [], apps: (c.people?.agents ?? []).map(agentLine) }
}

const SAFE = [/^kagelets\.(max|dailyUsd|totalDailyUsd|chainUsd|needsPerDay|askRunsPerHour|notesKept|noteChars|measureMinutes|trendRuns)$/, /^waiting\.expireHours$/, /^afk\.(on|model)$/, /^harness\.(jobModel|jobFreshEvery|jobCarry|jobCarryChars|jobLaneDefault)$/, /^jev\.(threshold|model|ackWords)$/, /^tripwires\.(timeoutSec|maxKb|failPing|patternMax|lineMax|maxPosts|catchUpMax|seenMax|hookPerHour|swapAfter|shadowWindowMin|swapUndoDays)$/,
  /^connectors\.(voice|github|meeting|browser|whatsapp)\.(port|max|perHour|hookPort)$/, /^connectors\.whatsapp\.(model|checkMinutes)$/]
export function settingTier(key: string): 'safe' | 'power' | 'never' {
  const parts = key.split('.')
  if (!key || parts.some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p)) || ['secrets', 'version', 'unknown'].includes(parts[0]!)) return 'never'
  return SAFE.some(r => r.test(key)) ? 'safe' : 'power'
}
