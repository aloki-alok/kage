// Hook rules inside a Kage session: private sources, the owner's memory, the sender file.
import { readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'

// Sources that hold the owner's private data. Only the owner's own task may read them.
// browser_: Kage's own tools on the owner's Chrome, where every tab carries their logins (#114).
const PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies|kage_?_browser_)/i
export function privateToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (!PRIVATE_TOOL.test(tool) || sender === 'owner') return undefined
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`
}
// A voice call may be anyone, and its session holds the owner's memory in context, so it gets its
// reply tool and nothing else: no shell, no files, no web (a URL can carry that context out), no
// posting, no schedules, no other MCP tools. Its approval prompts never reach the owner either.
const VOICE_OK = new Set(['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'ToolSearch'])   // the reply tool (dev-route and plugin-route names), and ToolSearch, which loads it when deferred
export function voiceToolRefusal(tool: string, sender: string | undefined): string | undefined {
  if (sender !== 'voice' || VOICE_OK.has(tool)) return undefined
  return `${tool} is not allowed on a voice call: anyone may be talking. Answer from what you know, or say you will check with the owner.`
}
// A Slack connector posts as the owner with no sign of Kage. Kage's reply and message_people tools
// post as Kage, or mark a post from the owner's account, so every Slack post goes through them.
// Any Slack server's tool that sends, posts, schedules or replies; drafts post nothing.
const SLACK_SEND = /^mcp__[^_]*.*slack.*__.*(send|post|schedule|reply|add_message)/i
export function slackSendRefusal(tool: string): string | undefined {
  if (!SLACK_SEND.test(tool) || /draft/i.test(tool)) return undefined
  return `${tool} posts as the owner with no sign of Kage. Use the reply tool for this thread, or message_people to tell someone else.`
}
// The config folder holds the tokens (secrets.json, and an env file until its import is deleted). No session may read
// those, the owner's included: Kage's own tools post as the bot, so no session needs a token. The owner's sessions may
// read config.json. Anyone else's task never touches the folder. Its files/ (each thread's files, for send_file and
// reports) and memory/ (Kage's own lessons) stay open to every task.
// configRefusal is the fallback: a path match cannot stop a shell. protectConfig below is the wall (Claude Code's own
// permission rules for the file tools, the OS sandbox for the shell), measured in the #105 spike and for #116.
const CONFIG_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
const CONFIG_WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const NOT_PATHS = new Set(['content', 'old_string', 'new_string', 'new_source', 'description', 'edits'])
const TOKEN_FILE = /^(?:secrets\.json|env[\w.-]*)$/
export function configRefusal(tool: string, input: Record<string, unknown>, sender: string | undefined, envFile: string, home = process.env.HOME ?? ''): string | undefined {
  if (!CONFIG_TOOLS.has(tool)) return
  const dir = dirname(envFile)
  // The forms a model types: absolute, the real path, ~, $HOME, and relative to the home folder sessions start in.
  const forms = [...new Set([dir, realish(dir), dir.startsWith(`${home}/`) ? dir.slice(home.length + 1) : ''])].filter(Boolean)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    // A shell can name the folder a hundred ways (cd, a glob, a variable), so it may not name it at all. The sandbox (protectConfig) is the real wall.
    if (tool === 'Bash') return at.length ? closed : undefined
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
// failIfUnavailable: a session never starts without the wall. Writes elsewhere and the network stay open, as without a sandbox.
// Every name the hub reads or writes in the config folder (grep '${DIR}/' and '${CONF}/'; a test in core/tests/guards.test.ts fails when a
// new one is missing). The hub does the writing itself, so a shell needs none. A name absent today must be listed too: the hub adopts a
// crons-import.json, a threads.json or a waha/.env it finds at its next start. The folder's own entries are added at session start.
const CONFIG_NAMES = ['session.env', 'kagelets', 'specialists', 'config.json*', 'crons-import.json*', 'waha', 'threads.json*', 'afk.json*', 'github-threads.json*', 'mail-threads.json*',
  'kage.db*', 'hub.lock', 'hub.log*', 'router.sock', '.archive', 'updated-from', 'browser-seen', 'wa-notes', 'retro-sent', 'dream-sent', 'daily-sent', 'crash-dm-at',
  'config-unknown-told', 'canvas-events.jsonl', 'boots', 'held', 'sender', 'ledgers']
export function protectConfig(envFile: string, codeDir: string, home = process.env.HOME ?? '') {
  const dirs = [...new Set([dirname(envFile), realish(dirname(envFile))])]
  const tokens = dirs.flatMap(d => [`${d}/secrets.json*`, `${d}/env*`])
  const kept = new Set(['files', 'memory'])
  const folder = dirs.flatMap(d => [...new Set([...CONFIG_NAMES,
    ...(() => { try { return readdirSync(d) } catch { return [] } })().filter(n => !kept.has(n))])].map(n => `${d}/${n}`))
  const deny = (f: string) => [`Edit(/${f})`]
  return {
    permissions: { deny: dirs.flatMap(d => [`Read(/${d}/secrets.json)`, `Read(/${d}/env*)`, ...['secrets.json', 'env*', 'config.json'].flatMap(f => deny(`${d}/${f}`))]) },
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
const CLOSED_WRITE = `Settings and token files are closed to every session: only the owner's own terminal changes them (kage set). Say what you wanted changed, and the owner runs it.`
// Kage's own memory (hub.ts points autoMemoryDirectory at it) and the owner's, which is the
// memory of the home folder project in Claude Code.
export const memoryDirs = (home: string, envFile: string, env: Record<string, string | undefined>) => ({
  own: env.KAGE_MEMORY || `${dirname(envFile)}/memory`,
  owner: env.KAGE_OWNER_MEMORY || `${home}/.claude/projects/${home.replace(/[^A-Za-z0-9]/g, '-')}/memory`,
})
// Kage keeps its own memory; in the owner's it may write only notes about people (user_*.md) and
// edit the index that lists them. ponytail: covers the file tools, not a shell redirect into the
// folder, so it stops mistakes, not a determined session; add a Bash check if one is ever seen
// writing there that way. Hooks load only on the plugin route (hooks/hooks.json).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export function ownerMemoryRefusal(
  tool: string, input: { file_path?: string; notebook_path?: string }, ownerMemory: string, home = process.env.HOME ?? '',
): string | undefined {
  const raw = input.file_path ?? input.notebook_path
  if (!WRITE_TOOLS.has(tool) || !raw) return
  // Compare real paths, lowercased: links are followed, and macOS treats Memory and memory alike.
  const file = realish(raw.replace(/^~(?=\/)/, home))
  const dir = realish(ownerMemory)
  if (!file.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return
  const name = file.slice(dir.length + 1)
  if (/^user_[\w-]+\.md$/.test(name) || (name === 'MEMORY.md' && tool !== 'Write')) return
  return `The owner's memory takes only people notes (user_<name>.md) from you. Save your own lessons in your own memory folder.`
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
// Where the server records who sent a thread's latest task, for the private-data hook.
export const senderFile = (dir: string, thread: string) => `${dir}/sender/${thread.replace(/[^A-Za-z0-9.]/g, '_')}`
