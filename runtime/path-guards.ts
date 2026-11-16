// Hook rules that compare real paths on disk: the config folder that holds the tokens, and the owner's memory.
// They follow links, so they read the filesystem and live here, not in core/ (ADR 0001).
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { mcpToolRefusal, privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../core/guards.ts'

// The config folder holds the tokens (secrets.json, and an env file until its import is deleted). No session may read
// those, the owner's included: Kage's own tools post as the bot, so no session needs a token. The owner's sessions may
// read config.json. Anyone else's task never touches the folder. Its files/ (each thread's files, for send_file and
// reports) and memory/ (Kage's own lessons) stay open to every task.
// configRefusal is the fallback: a path match cannot stop a shell. protectConfig below is the wall (Claude Code's own
// permission rules for the file tools, the OS sandbox for the shell when harness.sandbox is on), measured in the #105 spike and for #116.
// With it off, a shell is stopped only by this word match, which a reworded command (cd in steps, a glob) gets past.
const CONFIG_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
const CONFIG_WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const NOT_PATHS = new Set(['content', 'old_string', 'new_string', 'new_source', 'description', 'edits'])
// session.env becomes the hub's environment, and waha/ holds the WAHA key, so both count as token files.
const TOKEN_FILE = /^(?:secrets\.json|env[\w.-]*|session\.env[\w.-]*|waha)$/
export function configRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, envFile: string, home = process.env.HOME ?? ''): string | undefined {
  if (!CONFIG_TOOLS.has(tool)) return
  const dir = dirname(envFile)
  // The forms a model types: absolute, the real path, ~, $HOME, and relative to the home folder sessions start in.
  const forms = [...new Set([dir, realish(dir), dir.startsWith(`${home}/`) ? dir.slice(home.length + 1) : ''])].filter(Boolean)
  // Each word of each path-like input, with ~ and $HOME expanded and ./, // and .. folded away.
  const words = Object.entries(input).filter(([k, v]) => !NOT_PATHS.has(k) && typeof v === 'string').map(([, v]) => v as string)
    .map(v => v.replace(/(^|[\s'"=:])~(?=\/)/g, `$1${home}`).replace(/\$\{?HOME\}?/g, home))
    .flatMap(v => v.split(/[\s'"=:;&|<>()]+/)).filter(Boolean).map(w => posix.normalize(w).replace(/\/$/, ''))
  // What sits under the config folder: undefined for a word elsewhere, '' for the folder itself, else the path inside it.
  const inside = (w: string) => { const f = forms.find(f => w === f || w.startsWith(`${f}/`)); return f === undefined ? undefined : w.slice(f.length + 1) }
  const at = words.map(inside).filter((x): x is string => x !== undefined)
  if (sender === 'owner') {
    const first = (r: string) => r.split('/')[0]!
    const closed = `Kage's token files (secrets.json and the env files) are closed to every session, the owner's too. Kage's own tools post as Kage, so no session needs a token. Use the reply or message_people tool.`
    // A shell may name only files/ and memory/ in the folder, as the file tools may; anything else there (a token, the folder, a glob of it) is refused.
    // A shell can still reach the folder other ways (cd in steps, a variable): only the sandbox (protectConfig, harness.sandbox on) is a real wall.
    if (tool === 'Bash') return at.some(r => !/^(?:files|memory)\//.test(r)) ? closed : undefined
    if (CONFIG_WRITES.has(tool)) return at.some(r => first(r) === 'config.json' || TOKEN_FILE.test(first(r))) ? CLOSED_WRITE : undefined
    return at.some(r => r === '' || r === '.' || /[*?[{]/.test(r) || TOKEN_FILE.test(first(r))) ? closed : undefined
  }
  // Another task never touches the folder, except files/ (each thread's files, for send_file and reports) and memory/ (Kage's own lessons).
  if (!at.some(r => !/^(?:files|memory)(?:\/|$)/.test(r))) return
  return `Kage's config folder holds its tokens, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
// The settings every Kage SDK session starts with. An absolute path in a rule needs "//". Both the typed and the real
// folder are listed. An Edit rule covers every file-editing tool, Write too (a Write rule only warns). The shell sandbox
// denies reading the token files, and writing: the token files, config.json, and everything else in the config folder
// but files/ and memory/ (CONFIG_NAMES below, session.env is loaded into the hub's environment, kagelets/ holds the tools kagelets get), and
// the hub's own code folder (a restart runs it) and the login files the OS starts the hub from. The hub writes all of those
// itself, so a session needs none. An allowWrite does not reopen a denied path, so the folder's entries are listed one by one.
// harness.sandbox (off by default) adds the OS sandbox for the shell. failIfUnavailable: a session that asked for it never starts without it. Writes elsewhere and the network stay open, as without a sandbox.
// Every name the hub reads or writes in the config folder (grep '${DIR}/' and '${CONF}/'; a test in runtime/tests/path-guards.test.ts fails when a
// new one is missing). The hub does the writing itself, so a shell needs none. A name absent today must be listed too: the hub adopts a
// crons-import.json, a threads.json or a waha/.env it finds at its next start. The folder's own entries are added at session start.
const CONFIG_NAMES = ['session.env', 'telemetry-id', 'kagelets', 'config.json*', 'crons-import.json*', 'waha', 'threads.json*', 'afk.json*', 'github-threads.json*', 'mail-threads.json*',
  'kage.db*', 'hub.lock', 'hub.log*', 'router.sock', 'ssm.sock', 'keys.sock', '.archive', 'updated-from', 'browser-seen', 'wa-notes', 'retro-sent', 'dream-sent', 'daily-sent', 'crash-dm-at',
  'config-unknown-told', 'boots', 'held', 'sender', 'ledgers']
export function protectConfig(envFile: string, codeDir: string, home = process.env.HOME ?? '', sandbox = false) {
  const dirs = [...new Set([dirname(envFile), realish(dirname(envFile))])]
  const tokens = dirs.flatMap(d => [`${d}/secrets.json*`, `${d}/env*`, `${d}/session.env*`, `${d}/waha/.env*`])
  const kept = new Set(['files', 'memory'])
  const folder = dirs.flatMap(d => [...new Set([...CONFIG_NAMES,
    ...(() => { try { return readdirSync(d) } catch { return [] } })().filter(n => !kept.has(n))])].map(n => `${d}/${n}`))
  const deny = (f: string) => [`Edit(/${f})`]
  const permissions = { deny: dirs.flatMap(d => [`Read(/${d}/secrets.json)`, `Read(/${d}/env*)`, `Read(/${d}/session.env)`, `Read(/${d}/waha/.env)`, ...['secrets.json', 'env*', 'config.json', 'session.env', 'waha/.env'].flatMap(f => deny(`${d}/${f}`))]) }
  if (!sandbox) return { permissions }
  return {
    permissions,
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      network: { allowedDomains: ['*'], allowLocalBinding: true, allowAllUnixSockets: true },
      filesystem: {
        allowWrite: ['/'], denyRead: tokens,
        denyWrite: [...new Set([...tokens, ...folder, ...[codeDir, realish(codeDir)], `${home}/Library/LaunchAgents`, `${home}/.config/systemd`])],
      },
    },
  }
}
// Go tools (gh, wrangler's helpers, terraform) verify TLS on macOS through trustd, which the shell sandbox blocks
// (x509: OSStatus -26276). With SSL_CERT_FILE set, Go reads the system PEM instead, so the sandbox stays whole (#226).
export function certFileEnv(platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists = existsSync): Record<string, string> {
  const file = '/etc/ssl/cert.pem'
  return platform === 'darwin' && !env.SSL_CERT_FILE && exists(file) ? { SSL_CERT_FILE: file } : {}
}
const CLOSED_WRITE = `Settings and token files are closed to every session: only the owner's own terminal changes them (kage set). Say what you wanted changed, and the owner runs it.`
// Kage keeps its own memory; in the owner's it may write only notes about people (user_*.md) and
// edit the index that lists them. A task not from the owner may also read only those (#228); the owner's own task reads all.
// ponytail: covers the file tools, not a shell (cat, a redirect), so it stops mistakes, not a determined
// session; the real wall is a per-sender sandbox, which a session's fixed settings cannot give. Hooks load only on the plugin route (hooks/hooks.json).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
export function ownerMemoryRefusal(
  tool: string, input: { file_path?: string; notebook_path?: string; path?: string; pattern?: string }, ownerMemory: string, sender?: string,
  home = process.env.HOME ?? '', cwd = process.cwd(),
): string | undefined {
  const write = WRITE_TOOLS.has(tool)
  const read = READ_TOOLS.has(tool) && sender !== 'owner'
  if (!write && !read) return
  const dir = realish(ownerMemory).toLowerCase()
  // Where a search starts: its path, a Glob pattern's fixed part, or the session's folder when it names none.
  // A Glob resolves its pattern's fixed part from its path, so an absolute pattern or a .. in it counts.
  const tilde = (p: string) => p.replace(/^~(?=\/|$)/, home)
  const raw = tool === 'Glob' ? resolve(tilde(input.path ?? cwd), tilde((input.pattern ?? '').split(/[*?[{]/)[0]!))
    : input.file_path ?? input.notebook_path ?? input.path ?? (read && tool !== 'Read' ? cwd : undefined)
  if (!raw) return
  // Compare real paths, lowercased: links are followed, and macOS treats Memory and memory alike.
  const file = realish(raw.replace(/^~(?=\/)/, home)).replace(/\/$/, '').toLowerCase()
  if (read && tool !== 'Read' && dir.startsWith(`${file}/`)) return `This search would reach the owner's memory. Search a folder outside it, with its path.`
  if (file !== dir && !file.startsWith(`${dir}/`)) return
  const name = file.slice(dir.length + 1)
  if (/^user_[\w-]+\.md$/.test(name) || (write && name === 'memory.md' && tool !== 'Write')) return
  return `The owner's memory gives you only people notes (user_<name>.md). Save your own lessons in your own memory folder.`
}

// The real path of p, or of its nearest existing parent with the rest appended (a new file has no real path yet).
function realish(p: string): string {
  const rest: string[] = []
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest) } catch {}
    if (dirname(cur) === cur) return resolve(p)
    rest.unshift(basename(cur))
  }
}
// Every hook rule in one chain. The SDK runner and the tmux hook both call it, so a rule added here reaches both (#272).
export function toolRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, o: { ownerMemory: string; envFile: string; sharedTools?: readonly string[] }): string | undefined {
  return privateToolRefusal(tool, sender) ?? voiceToolRefusal(tool, sender) ?? mcpToolRefusal(tool, sender, o.sharedTools) ?? slackSendRefusal(tool)
    ?? ownerMemoryRefusal(tool, input as { file_path?: string }, o.ownerMemory, sender) ?? configRefusal(tool, input, sender, o.envFile)
}
