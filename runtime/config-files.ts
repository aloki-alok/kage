// config.json and secrets.json on disk: reading them, changing them, and the one-time import of the old env file.
// The pure schema and table are core/config.ts. KAGE_ENV still names a file in the config folder (the old env file), so
// service units that set it keep working: the folder is its dirname.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { badValue, Config, fromEnv, Secrets, settingTier } from '../core/config.ts'
import { parseEnv } from '../core/settings.ts'

export const files = (envFile: string) => ({ dir: dirname(envFile), config: join(dirname(envFile), 'config.json'), secrets: join(dirname(envFile), 'secrets.json'), legacy: envFile })
export const hasSettings = (envFile: string) => existsSync(files(envFile).config) || existsSync(envFile)

// A failed parse as a line a person reads: the file, the key and what is wrong. Never a value.
// The error carries the JSON keys that are wrong (names only), for the event log.
const why = (file: string, e: unknown) => {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues
  return `${file}: ${issues ? issues.map(i => `${i.path.join('.') || 'the file'}: ${i.message}`).join('; ') : (e as Error).message}`
}
// A SyntaxError quotes the file's text, which may be a token, into the log and the owner's DM: say only the line.
function json(text: string): unknown {
  try { return JSON.parse(text) } catch (e) {
    const at = /position (\d+)/.exec((e as Error).message)?.[1] ?? /line (\d+)/.exec((e as Error).message)?.[1]
    const line = /position/.test((e as Error).message) ? text.slice(0, Number(at)).split('\n').length : at
    throw new Error(`not valid JSON${line ? ` at line ${line}` : ''}`)
  }
}
const keysOf = (e: unknown) => ((e as { issues?: { path: PropertyKey[]; keys?: string[] }[] }).issues ?? []).flatMap(i => (i.keys ?? ['']).map(k => [...i.path, k].filter(Boolean).join('.'))).filter(Boolean)
const fail = (file: string, e: unknown) => Object.assign(new Error(why(file, e)), { keys: keysOf(e) })
function parse<T>(schema: { parse: (x: unknown) => T }, file: string): T {
  try { return schema.parse(json(readFileSync(file, 'utf8'))) } catch (e) { throw fail(file.split('/').pop()!, e) }
}

// A change checked against the schema before it is written, with the same short message as a bad file.
function checked<T>(schema: { parse: (x: unknown) => T }, name: string, value: unknown): T {
  try { return schema.parse(value) } catch (e) { throw fail(name, e) }
}

// Written beside the file, then moved over it: a crash midway leaves the old file whole. Always mode 600.
function write(file: string, data: unknown) {
  const tmp = `${file}.new`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')

// First start of the new code: no config.json and an env file. Both JSON files are written, then the env file is
// renamed to env.imported-<time>. A crash before the rename leaves the env file, and the next start imports again.
// ponytail: a crash after config.json and before the rename leaves a stale env file beside it; delete it by hand.
// Returns the imported file's new name, or undefined when there was nothing to do.
export function importLegacy(envFile: string, now = new Date()): string | undefined {
  const f = files(envFile)
  if (!existsSync(f.legacy)) return undefined
  // A crash between writing config.json and this rename leaves the env file, plaintext tokens and all. config.json wins, so only rename it.
  if (!existsSync(f.config)) {
    const { config, secrets } = fromEnv(parseEnv(readFileSync(f.legacy, 'utf8')))
    write(f.secrets, secrets)
    write(f.config, config)
  }
  const to = `${f.legacy}.imported-${stamp(now)}`
  renameSync(f.legacy, to)
  return to
}

// The imported env file holds every token, so it goes 7 days after the import.
export function sweepImported(envFile: string, now = new Date()): string[] {
  const f = files(envFile)
  const prefix = `${envFile.split('/').pop()}.imported-`
  const gone: string[] = []
  for (const name of readdirSync(f.dir).filter(n => n.startsWith(prefix))) {
    const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(name.slice(prefix.length))
    if (m && now.getTime() - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) > 7 * 86_400_000) { rmSync(join(f.dir, name)); gone.push(name) }
  }
  return gone
}

// Both files, checked. Before the import, an env file is read as if it had been imported, and nothing is written.
export function readSettings(envFile: string): { config: Config; secrets: Secrets } {
  const f = files(envFile)
  if (!existsSync(f.config)) {
    if (!existsSync(f.legacy)) throw new Error(`No settings at ${f.dir}. Run kage setup first.`)
    return fromEnv(parseEnv(readFileSync(f.legacy, 'utf8')))
  }
  return { config: parse(Config, f.config), secrets: existsSync(f.secrets) ? parse(Secrets, f.secrets) : {} }
}

// Read, change, write one file. An env file waiting to be imported goes in first, so a change is never lost to it.
// KAGE_SESSION is set on every session (SDK and tmux) and KAGE_THREAD on a pane: a session never changes the files from its shell.
// The sandbox is the wall (core/guards.ts protectConfig); this is the same refusal where the sandbox cannot be.
const sessionRefusal = () => { if (process.env.KAGE_SESSION || process.env.KAGE_THREAD) throw new Error("not changed: settings change only from the owner's own terminal. Say what you want changed, and the owner runs kage set.") }
export function updateConfig(envFile: string, change: (c: Config) => Config) {
  sessionRefusal()
  importLegacy(envFile)
  const f = files(envFile)
  write(f.config, checked(Config, 'config.json', change(existsSync(f.config) ? parse(Config, f.config) : { version: 1 })))
}
export function updateSecrets(envFile: string, change: (s: Secrets) => Secrets) {
  sessionRefusal()
  importLegacy(envFile)
  const f = files(envFile)
  write(f.secrets, checked(Secrets, 'secrets.json', change(existsSync(f.secrets) ? parse(Secrets, f.secrets) : {})))
}

// One config.json key from a dotted path, checked as the hub will read it (the schema, then checkSettings) before the file is written.
// The watcher sees the write and applies it live or by a quiet restart, as for any edit.
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
