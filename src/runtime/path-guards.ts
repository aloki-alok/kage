import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { SecretsFile } from '../core/config.ts'
import { secretCommands } from '../core/secret-commands.ts'
import { agentToolRefusal, mcpToolRefusal, SECRET_DIRS, SECRET_FILE, SECRET_GLOB, privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../core/guards.ts'

const CONFIG_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
const CONFIG_WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const NOT_PATHS = new Set(['content', 'old_string', 'new_string', 'new_source', 'description', 'edits'])
const TOKEN_FILE = /^(?:secrets\.json|owner\.key[\w.-]*|env[\w.-]*|session\.env[\w.-]*|waha)$/
const SIGNING_FILE = /^screen(?:\/signing|\/?$)/ 
export function configRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, envFile: string, home = process.env.HOME ?? ''): string | undefined {
  if (!CONFIG_TOOLS.has(tool)) return
  const dir = dirname(envFile)
  const forms = [...new Set([dir, realish(dir), dir.startsWith(`${home}/`) ? dir.slice(home.length + 1) : ''])].filter(Boolean)
  const words = Object.entries(input).filter(([k, v]) => !NOT_PATHS.has(k) && typeof v === 'string').map(([, v]) => v as string)
    .map(v => v.replace(/(^|[\s'"=:])~(?=\/)/g, `$1${home}`).replace(/\$\{?HOME\}?/g, home))
    .flatMap(v => v.split(/[\s'"=:;&|<>()]+/)).filter(Boolean).map(w => posix.normalize(w).replace(/\/$/, ''))
  const inside = (w: string) => { const f = forms.find(f => w === f || w.startsWith(`${f}/`)); return f === undefined ? undefined : w.slice(f.length + 1) }
  const at = words.map(inside).filter((x): x is string => x !== undefined)
  if (sender === 'owner') {
    const first = (r: string) => r.split('/')[0]!
    const closed = `Kage's token files (secrets.json and the env files) are closed to every session, the owner's too. Kage's own tools post as Kage, so no session needs a token. Use the reply or message_people tool.`
    if (tool === 'Bash') return at.some(r => !/^(?:files|memory)\//.test(r)) ? closed : undefined
    if (CONFIG_WRITES.has(tool)) return at.some(r => first(r) === 'config.json' || TOKEN_FILE.test(first(r)) || SIGNING_FILE.test(r)) ? CLOSED_WRITE : undefined
    return at.some(r => r === '' || r === '.' || /[*?[{]/.test(r) || TOKEN_FILE.test(first(r)) || SIGNING_FILE.test(r)) ? closed : undefined
  }
  if (!at.some(r => !/^(?:files|memory)(?:\/|$)/.test(r))) return
  return `Kage's config folder holds its tokens, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
const AT_COMMAND = String.raw`(?:^|[;&|(\x60]|\$\(|\b(?:sh|bash|zsh|eval|exec|env|xargs|sudo|command|nohup|time)\s+(?:-\S+\s+)*)\s*(?:\w+=\S*\s+)*`
const SECRET_HELPER = new RegExp(AT_COMMAND + String.raw`(?:security\s+(?:-\S+\s+)*(?:find-(?:generic|internet)-password|dump-keychain)|op\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(?:read|inject|run|item|document)|(?:go)?pass\s+(?:-\S+\s+)*(?:show|otp|\S+\/)|lpass\s+show|secret-tool\s+lookup|bw\s+get)\b`)
const plainShell = (s: string) => s.replace(/\\\n/g, ' ').replace(/['"]/g, '').replace(/\s+/g, ' ').trim()
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const asCommand = (c: string) => new RegExp(String.raw`(?:^|[\s;&|(\x60])${escaped(c)}(?=$|[\s;&|)\x60])`)
const OWNER_WRITE_COMMAND = new RegExp(AT_COMMAND + String.raw`(?:(?:-u|--unset)\s+\S+\s+|\w+=\S*\s+|-\S+\s+)*(?:(?:\S*\/)?(?:kage|setup\.sh)\s+(?:tell|relay|stop|attach|call|reload|restart|add|remove|trust\s+(?:confirm|revoke))|(?:\S*\/)?node\s+(?:-\S+\s+)*\S*src\/cli\/(?:(?:tell|relay|stop|attach|call|reload|quiet|registry)\.ts|trust\.ts\s+(?:confirm|revoke)))(?=$|[\s;&|)\x60])`)
const kageWriteRefusal = (tool: string, input: Record<string, unknown>) => tool === 'Bash' && typeof input.command === 'string' && OWNER_WRITE_COMMAND.test(plainShell(input.command))
  ? "The kage commands that act as the owner (tell, relay, stop, attach, call, reload, restart, add, remove, trust confirm, trust revoke) run only in the owner's own terminal. Say what you wanted done, and the owner runs it." : undefined
function secretCommandRefusal(tool: string, input: Record<string, unknown>, envFile: string): string | undefined {
  if (tool !== 'Bash' || typeof input.command !== 'string') return
  let commands: string[]
  try { commands = secretCommands(SecretsFile.parse(JSON.parse(readFileSync(join(dirname(envFile), 'secrets.json'), 'utf8')))).flatMap(c => [plainShell(c.command), plainShell(c.command).replace(/^\S*\//, '')]) } catch { return }
  const asked = plainShell(input.command)
  if (!commands.length || !(SECRET_HELPER.test(asked) || commands.some(c => asCommand(c).test(asked)))) return
  return `Kage's tokens come from commands in secrets.json, so no session may run one, or another secret helper (op read, security find-*, pass show). Kage's own tools post as Kage, so no session needs a token.`
}
const CONFIG_NAMES = ['session.env', 'telemetry-id', 'kagelets', 'job-state', 'config.json*', 'crons-import.json*', 'waha', 'screen', 'threads.json*', 'afk.json*', 'github-threads.json*', 'mail-threads.json*',
  'kage.db*', 'hub.lock', 'hub.log*', 'router.sock', 'ssm.sock', 'keys.sock', '.archive', 'updated-from', 'browser-seen', 'wa-notes', 'retro-sent', 'dream-sent', 'daily-sent', 'crash-dm-at',
  'config-unknown-told', 'boots', 'held', 'sender', 'ledgers', 'last-seen']
export function protectConfig(envFile: string, codeDir: string, home = process.env.HOME ?? '', sandbox: boolean | 'kagelet' = false) {
  const dirs = [...new Set([dirname(envFile), realish(dirname(envFile))])]
  const tokens = dirs.flatMap(d => [`${d}/secrets.json*`, `${d}/owner.key*`, `${d}/env*`, `${d}/session.env*`, `${d}/waha/.env*`])
  const kept = new Set(['files', 'memory'])
  const folder = dirs.flatMap(d => [...new Set([...CONFIG_NAMES,
    ...(() => { try { return readdirSync(d) } catch { return [] } })().filter(n => !kept.has(n))])].map(n => `${d}/${n}`))
  const deny = (f: string) => [`Edit(/${f})`]
  const logins = [`${home}/Library/LaunchAgents`, `${home}/.config/systemd`]
  const permissions = { deny: [...dirs.flatMap(d => [`Read(/${d}/secrets.json)`, `Read(/${d}/owner.key)`, `Read(/${d}/env*)`, `Read(/${d}/session.env)`, `Read(/${d}/waha/.env)`, ...['secrets.json', 'owner.key', 'env*', 'config.json', 'session.env', 'waha/.env'].flatMap(f => deny(`${d}/${f}`))]),
    ...sandbox === 'kagelet' ? [...new Set([codeDir, realish(codeDir), ...logins])].flatMap(d => deny(`${d}/**`)) : []] }
  if (!sandbox) return { permissions }
  return {
    permissions,
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      network: { allowedDomains: ['*'], allowLocalBinding: true, allowAllUnixSockets: sandbox !== 'kagelet',
        ...sandbox === 'kagelet' && { allowUnixSockets: [process.env.GNUPGHOME ?? `${home}/.gnupg`, process.env.SSH_AUTH_SOCK].filter((s): s is string => !!s) } },
      filesystem: {
        allowWrite: ['/'], denyRead: tokens,
        denyWrite: [...new Set([...tokens, ...folder, ...[codeDir, realish(codeDir)], ...logins])],
      },
    },
  }
}
export function certFileEnv(platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists = existsSync): Record<string, string> {
  const file = '/etc/ssl/cert.pem'
  return platform === 'darwin' && !env.SSL_CERT_FILE && exists(file) ? { SSL_CERT_FILE: file } : {}
}
const CLOSED_WRITE = `Settings and token files are closed to every session: only the owner's own terminal changes them (kage set). Say what you wanted changed, and the owner runs it.`
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
export function ownerMemoryRefusal(
  tool: string, input: { file_path?: string; notebook_path?: string; path?: string; pattern?: string }, ownerMemory: string, sender?: string,
  home = process.env.HOME ?? '', cwd = process.cwd(), side = false,
): string | undefined {
  const write = WRITE_TOOLS.has(tool)
  const read = READ_TOOLS.has(tool) && sender !== 'owner'
  if (!write && !read) return
  const dir = realish(ownerMemory).toLowerCase()
  const tilde = (p: string) => p.replace(/^~(?=\/|$)/, home)
  const raw = tool === 'Glob' ? resolve(tilde(input.path ?? cwd), tilde((input.pattern ?? '').split(/[*?[{]/)[0]!))
    : input.file_path ?? input.notebook_path ?? input.path ?? (read && tool !== 'Read' ? cwd : undefined)
  if (!raw) return
  const real = realish(raw.replace(/^~(?=\/)/, home)).replace(/\/$/, '')
  const file = real.toLowerCase()
  if (read && tool !== 'Read' && dir.startsWith(`${file}/`)) return `This search would reach the owner's memory. Search a folder outside it, with its path.`
  if (file !== dir && !file.startsWith(`${dir}/`)) return
  const name = file.slice(dir.length + 1)
  if (/^user_[\w-]+\.md$/.test(name) || (write && name === 'memory.md' && tool !== 'Write')) return
  if (sender === 'owner' && !side && (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') && existsSync(real)) return
  const refusal = `The owner's memory gives you only people notes (user_<name>.md). Save your own lessons in your own memory folder.`
  return sender === 'owner' && !side && tool === 'Write' ? `${refusal} A new note that is not about a person belongs in Kage's memory.` : refusal
}

function realish(p: string): string {
  const rest: string[] = []
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest) } catch {}
    if (dirname(cur) === cur) return resolve(p)
    rest.unshift(basename(cur))
  }
}
const DREAM_REFUSAL = 'A new lesson goes through dream_lessons, which checks it against the threads first. Here you only tidy notes that exist, with the Write and Edit tools.'
export function dreamNoteRefusal(tool: string, input: { file_path?: string; notebook_path?: string; command?: string }, ownMemory: string, home = process.env.HOME ?? ''): string | undefined {
  const dir = realish(ownMemory)
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    const names = [ownMemory, dir, ...home && dir.startsWith(`${realish(home)}/`) ? [`~${dir.slice(realish(home).length)}`, `$HOME${dir.slice(realish(home).length)}`] : []]
    return names.some(n => command.includes(n)) ? DREAM_REFUSAL : undefined
  }
  const raw = WRITE_TOOLS.has(tool) ? input.file_path ?? input.notebook_path : undefined
  if (!raw) return
  const file = realish(raw)
  if (!file.startsWith(`${dir}/`) || existsSync(file)) return
  const name = file.slice(dir.length + 1)
  if (name === 'MEMORY.md' || name === '.dream-ledger.tsv' || name.startsWith('.archive/')) return
  return DREAM_REFUSAL
}
export function agentReadRefusal(tool: string, input: { file_path?: string; path?: string; pattern?: string }, sender: string | undefined, home = process.env.HOME ?? ''): string | undefined {
  const target = sender !== 'agent' ? undefined : tool === 'Read' ? input.file_path : tool === 'Grep' || tool === 'Glob' ? (input.path ?? home) : undefined
  if (!target) return undefined
  const base = realish(home), full = realish(resolve(home, target)), glob = tool === 'Glob' ? String(input.pattern ?? '') : ''
  const secret = SECRET_DIRS.some(d => { const dir = join(base, d); return full === dir || full.startsWith(dir + '/') || (full === base && glob.includes(d)) })
    || SECRET_FILE.test(full) || SECRET_GLOB.test(glob)
  return secret ? `${target} may hold secrets, and an agent's task does not read them.` : undefined
}
export function toolRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, o: { ownerMemory: string; envFile: string; sharedTools?: readonly string[]; side?: boolean }): string | undefined {
  return agentToolRefusal(tool, sender) ?? agentReadRefusal(tool, input as { file_path?: string }, sender) ?? privateToolRefusal(tool, sender) ?? voiceToolRefusal(tool, sender) ?? mcpToolRefusal(tool, sender, o.sharedTools) ?? slackSendRefusal(tool)
    ?? ownerMemoryRefusal(tool, input as { file_path?: string }, o.ownerMemory, sender, undefined, undefined, o.side) ?? kageWriteRefusal(tool, input) ?? secretCommandRefusal(tool, input, o.envFile) ?? configRefusal(tool, input, sender, o.envFile)
}
