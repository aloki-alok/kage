import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { badValue, Config, fromEnv, mergeTeammateEmails, oldPeopleShape, Secrets, SecretsFile, settingTier } from '../core/config.ts'
import { resolveSecrets, type SecretCommand } from '../core/secret-commands.ts'
import { parseEnv } from '../core/settings.ts'

export const envFilePath = () => process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`

export const files = (envFile: string) => ({ dir: dirname(envFile), config: join(dirname(envFile), 'config.json'), secrets: join(dirname(envFile), 'secrets.json'), legacy: envFile })
export const hasSettings = (envFile: string) => existsSync(files(envFile).config) || existsSync(envFile)

const why = (file: string, e: unknown) => {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues
  return `${file}: ${issues ? issues.map(i => `${i.path.join('.') || 'the file'}: ${i.message}`).join('; ') : (e as Error).message}`
}
function json(text: string): unknown {
  try { return JSON.parse(text) } catch (e) {
    const at = /position (\d+)/.exec((e as Error).message)?.[1] ?? /line (\d+)/.exec((e as Error).message)?.[1]
    const line = /position/.test((e as Error).message) ? text.slice(0, Number(at)).split('\n').length : at
    throw new Error(`not valid JSON${line ? ` at line ${line}` : ''}`)
  }
}
const keysOf = (e: unknown) => ((e as { issues?: { path: PropertyKey[]; keys?: string[] }[] }).issues ?? []).flatMap(i => (i.keys ?? ['']).map(k => [...i.path, k].filter(Boolean).join('.'))).filter(Boolean)
const fail = (file: string, e: unknown) => Object.assign(new Error(why(file, e)), { keys: keysOf(e) })
const RETIRED = ['harness.unsandboxedCommands']
function dropRetired(raw: unknown, file: string) {
  for (const k of RETIRED) {
    const [a, b] = k.split('.') as [string, string]
    const o = (raw as Record<string, Record<string, unknown> | undefined> | null)?.[a]
    if (o && typeof o === 'object' && b in o) { delete o[b]; process.stderr.write(`${new Date().toISOString()} ${file}: ${k} is retired and ignored (the SSM relay replaced it). Remove it from the file.\n`) }
  }
  return raw
}
function parse<T>(schema: { parse: (x: unknown) => T }, file: string): T {
  try { return schema.parse(dropRetired(json(readFileSync(file, 'utf8')), file.split('/').pop()!)) } catch (e) { throw fail(file.split('/').pop()!, e) }
}

function checked<T>(schema: { parse: (x: unknown) => T }, name: string, value: unknown): T {
  try { return schema.parse(value) } catch (e) { throw fail(name, e) }
}

function write(file: string, data: unknown) {
  const tmp = `${file}.new`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')

export function importLegacy(envFile: string, now = new Date()): string | undefined {
  const f = files(envFile)
  if (!existsSync(f.legacy)) return undefined
  if (!existsSync(f.config)) {
    const { config, secrets } = fromEnv(parseEnv(readFileSync(f.legacy, 'utf8')))
    write(f.secrets, secrets)
    write(f.config, config)
  }
  const to = `${f.legacy}.imported-${stamp(now)}`
  renameSync(f.legacy, to)
  return to
}

export async function tidyPeople(envFile: string, userOfEmail: (email: string) => Promise<string | undefined>, now = new Date()) {
  const f = files(envFile)
  if (!existsSync(f.config)) return undefined
  const before = readFileSync(f.config, 'utf8')
  if (!oldPeopleShape(json(before))) return undefined
  const config = parse(Config, f.config)
  const found: Record<string, string> = {}
  let unchecked = 0
  for (const t of config.people?.teammates ?? []) {
    const user = t.email && !t.user ? await userOfEmail(t.email).catch(() => { unchecked++; return undefined }) : undefined
    if (user) found[t.email!] = user
  }
  if (readFileSync(f.config, 'utf8') !== before) return undefined
  const { teammates, moved } = mergeTeammateEmails(config.people?.teammates ?? [], found)
  const backup = `config.json.before-tidy-${stamp(now)}`
  writeFileSync(join(f.dir, backup), before, { mode: 0o600 })
  write(f.config, checked(Config, 'config.json', { ...config, people: { ...config.people, ...(teammates.length && { teammates }) } }))
  return { backup, moved, unchecked }
}

export function syncWaha(envFile: string): boolean {
  const f = files(envFile), file = join(f.dir, 'waha', '.env')
  const s = existsSync(f.secrets) ? parse(SecretsFile, f.secrets) : {}
  const onDisk = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : undefined
  if (!s.waha) {
    if (onDisk) write(f.secrets, checked(SecretsFile, 'secrets.json', { ...s, waha: onDisk }))
    return false
  }
  if (JSON.stringify(onDisk) === JSON.stringify(s.waha)) return false
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.new`, Object.entries(s.waha).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 })
  renameSync(`${file}.new`, file)
  return true
}

export function sweepKeptCopies(envFile: string, now = new Date()): string[] {
  const f = files(envFile)
  const prefixes = [`${envFile.split('/').pop()}.imported-`, 'config.json.before-tidy-']
  const gone: string[] = []
  for (const name of readdirSync(f.dir)) {
    const prefix = prefixes.find(p => name.startsWith(p))
    const m = prefix && /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(name.slice(prefix.length))
    if (m && now.getTime() - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) > 7 * 86_400_000) { rmSync(join(f.dir, name)); gone.push(name) }
  }
  return gone
}

const secretValues = new Map<string, string>()
function runSecret(command: string): string | undefined {
  if (!secretValues.has(command)) {
    try {
      const out = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '')
      if (out) secretValues.set(command, out)
    } catch {}
  }
  return secretValues.get(command)
}

export function readSettings(envFile: string): { config: Config; secrets: Secrets; failed: SecretCommand[] } {
  const f = files(envFile)
  if (!existsSync(f.config)) {
    if (!existsSync(f.legacy)) throw new Error(`No settings at ${f.dir}. Run kage setup first.`)
    return { ...fromEnv(parseEnv(readFileSync(f.legacy, 'utf8'))), failed: [] }
  }
  return { config: parse(Config, f.config), ...resolveSecrets(existsSync(f.secrets) ? parse(SecretsFile, f.secrets) : {}, runSecret) }
}

const sessionRefusal = () => { if (process.env.KAGE_SESSION || process.env.KAGE_THREAD) throw new Error("not changed: settings change only from the owner's own terminal. Say what you want changed, and the owner runs kage set.") }
export function updateConfig(envFile: string, change: (c: Config) => Config) {
  sessionRefusal()
  importLegacy(envFile)
  const f = files(envFile)
  write(f.config, checked(Config, 'config.json', change(existsSync(f.config) ? parse(Config, f.config) : { version: 1 })))
}
export function updateSecrets(envFile: string, change: (s: SecretsFile) => SecretsFile) {
  sessionRefusal()
  importLegacy(envFile)
  const f = files(envFile)
  write(f.secrets, checked(SecretsFile, 'secrets.json', change(existsSync(f.secrets) ? parse(SecretsFile, f.secrets) : {})))
}

export function setKey(envFile: string, key: string, value: unknown) {
  if (settingTier(key) === 'never') throw new Error(`${key} cannot be set this way`)
  const { config } = readSettings(envFile)
  const next = structuredClone(config) as Record<string, any>
  const ks = key.split('.')
  const last = ks.pop()!
  let at = next
  for (const k of ks) at = (at[k] ??= {})
  at[last] = value
  const done = checked(Config, 'config.json', next)
  const bad = badValue(done)
  if (bad) throw new Error(bad)
  updateConfig(envFile, () => done)
}
