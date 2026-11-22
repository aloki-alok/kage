#!/usr/bin/env node
import { tilde } from '../core/config.ts'
import { ENV_FILE } from './home.ts'
import { readSettings, setKey, updateConfig, updateSecrets } from '../runtime/config-files.ts'
import { readFileSync } from 'node:fs'
import { keyHelp, settingDocs, settingsOverview } from '../core/setting-docs.ts'

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const [cmd = '', key = '', ...rest] = process.argv.slice(2)
const walk = (o: unknown, path: string) => path.split('.').reduce<any>((x, k) => x?.[k], o)

if (cmd === 'has') {
  let s
  try { s = readSettings(ENV_FILE) } catch { process.exit(1) }
  const v = key.startsWith('secrets.') ? walk(s.secrets, key.slice(8)) : walk(s.config, key)
  process.exit(v === undefined || v === null || v === '' ? 1 : 0)
} else if (cmd === 'check-slack') {
  let token: string | undefined
  try { token = walk(readSettings(ENV_FILE).secrets, `slack.${key}`) } catch {}
  if (!token) die('not set')
  const r = await fetch(`https://slack.com/api/${key === 'app' ? 'apps.connections.open' : 'auth.test'}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).then(x => x.json() as Promise<{ ok: boolean; error?: string }>).catch(() => ({ ok: false, error: 'no answer from Slack' }))
  if (!r.ok) die(`Slack says: ${r.error}`)
  console.log('ok')
} else if (cmd === 'get') {
  if (key === 'secrets' || key.startsWith('secrets.')) process.exit(0)
  let s
  try { s = readSettings(ENV_FILE) } catch { process.exit(0) }
  const v = walk(s.config, key)
  if (v === undefined || v === null) process.exit(0)
  console.log(key === 'harness.cwd' ? tilde(String(v), process.env.HOME!) : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v))
} else if (cmd === 'set') {
  const docs = settingDocs(readFileSync(new URL('../docs/settings.md', import.meta.url), 'utf8'))
  let config: unknown = {}
  try { config = readSettings(ENV_FILE).config } catch {}
  if (!key) { console.log(settingsOverview(docs, k => walk(config, k)).join('\n')); process.exit(0) }
  if (!rest.length) { const help = keyHelp(docs, key, walk(config, key)); console.log(help.join('\n')); process.exit(help.length > 1 ? 0 : 1) }
  if (rest.length !== 1) die(`Usage: kage set ${key} <value>. A value with spaces goes in quotes, and a list is JSON.`)
  const value = rest[0]!
  let parsed: unknown = value
  try { parsed = JSON.parse(value) } catch {}
  try {
    setKey(ENV_FILE, key, parsed)
  } catch (e) { die([`Not changed: ${(e as Error).message.replace(/^config\.json: /, '')}`, ...docs.some(d => d.key === key) ? [] : keyHelp(docs, key, undefined)].join('\n')) }
  console.log(`Set ${key}. The people lists apply at once. Any other key applies by itself once every session is quiet (or run kage restart).`)
} else if (cmd === 'save') {
  const words = (await new Promise<string>(res => { let t = ''; process.stdin.on('data', d => t += d).on('end', () => res(t)) })).split(/\s+/).filter(Boolean)
  const [app, user, bot] = ['xapp-', 'xoxp-', 'xoxb-'].map(p => words.find(w => w.startsWith(p)))
  if (!app || !user || !bot) die('Need all three tokens on stdin: xapp-..., xoxp-..., xoxb-...')
  updateSecrets(ENV_FILE, s => ({ ...s, slack: { app, user, bot } }))
  updateConfig(ENV_FILE, c => ({ ...c, name: key || c.name }))
} else if (cmd === 'save-claude') {
  const token = (await new Promise<string>(res => { let t = ''; process.stdin.on('data', d => t += d).on('end', () => res(t)) })).trim()
  if (!/^sk-ant-oat\S+$/.test(token)) die('Not a Claude login token: run claude setup-token and paste the sk-ant-oat... line it prints.')
  updateSecrets(ENV_FILE, s => ({ ...s, claudeToken: token }))
} else if (cmd === 'save-github') {
  const token = (await new Promise<string>(res => { let t = ''; process.stdin.on('data', d => t += d).on('end', () => res(t)) })).trim()
  const ask = (path: string) => fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }).catch(() => die('No answer from GitHub. Check the network, then run kage connect github again.'))
  const user = await ask('/user')
  if (!user.ok) die(`GitHub refused this token (${user.status}). Run gh auth login, or make a new classic token, then run kage connect github again.`)
  if (!(await ask('/notifications?per_page=1')).ok) die('This token cannot read notifications. Use a gh login, or a classic token with the notifications and repo scopes: fine-grained tokens cannot read notifications.')
  const { login } = await user.json() as { login: string }
  updateSecrets(ENV_FILE, s => ({ ...s, githubToken: token }))
  updateConfig(ENV_FILE, c => ({ ...c, connectors: { ...c.connectors, github: { ...c.connectors?.github, login } } }))
  console.log(login)
} else if (cmd === 'github-off') {
  updateSecrets(ENV_FILE, ({ githubToken: _token, githubSecret: _secret, ...s }) => s)
  updateConfig(ENV_FILE, ({ connectors: { github: _github, ...connectors } = {}, ...c }) => ({ ...c, connectors }))
} else die('Usage: config.ts get <key> | has <key> | check-slack <app|user|bot> | set <key> <value> | save <name> | save-claude | save-github | github-off')
