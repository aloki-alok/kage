#!/usr/bin/env node
// Settings from a shell: setup.sh and service.sh read them here, and kage set changes one.
//   config.ts get <key>          a value from config.json, or secrets.<key> from secrets.json. A list prints comma separated, nothing prints for an unset key.
//   config.ts set <key> <value>  one config.json key. The value is JSON when it parses ("6", "true", "[\"a\"]"), else text. The file is checked before it is written.
//   config.ts save <name>        the three Slack tokens, as words on stdin, into secrets.json (kage save)
import { Config, tilde } from '../core/config.ts'
import { ENV_FILE } from './home.ts'
import { readSettings, updateConfig, updateSecrets } from '../runtime/config-files.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [cmd = '', key = '', ...rest] = process.argv.slice(2)
const walk = (o: unknown, path: string) => path.split('.').reduce<any>((x, k) => x?.[k], o)

if (cmd === 'get') {
  let s
  try { s = readSettings(ENV_FILE) } catch { process.exit(0) }   // no settings yet: the caller's default applies
  const v = key.startsWith('secrets.') ? walk(s.secrets, key.slice(8)) : walk(s.config, key)
  if (v === undefined || v === null) process.exit(0)
  console.log(key === 'harness.cwd' ? tilde(String(v), process.env.HOME!) : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v))
} else if (cmd === 'set') {
  if (!key || rest.length !== 1) die('Usage: kage set <key> <value>, a key such as harness.maxSessions. kage help set shows an example.')
  const value = rest[0]!
  let parsed: unknown = value
  try { parsed = JSON.parse(value) } catch {}
  try {
    updateConfig(ENV_FILE, c => {
      const next = structuredClone(c) as Record<string, any>
      const ks = key.split('.')
      const last = ks.pop()!
      let at = next
      for (const k of ks) at = (at[k] ??= {})
      at[last] = parsed
      return next as Config
    })
  } catch (e) { die(`Not changed: ${(e as Error).message.replace(/^config\.json: /, '')}`) }
  console.log(`Set ${key}. Run kage restart to apply it.`)
} else if (cmd === 'save') {
  const words = (await new Promise<string>(res => { let t = ''; process.stdin.on('data', d => t += d).on('end', () => res(t)) })).split(/\s+/).filter(Boolean)
  const [app, user, bot] = ['xapp-', 'xoxp-', 'xoxb-'].map(p => words.find(w => w.startsWith(p)))
  if (!app || !user || !bot) die('Need all three tokens on stdin: xapp-..., xoxp-..., xoxb-...')
  updateSecrets(ENV_FILE, s => ({ ...s, slack: { app, user, bot } }))
  updateConfig(ENV_FILE, c => ({ ...c, name: key || c.name }))
} else die('Usage: config.ts get <key> | set <key> <value> | save <name>')
