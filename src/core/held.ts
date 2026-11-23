type Cmd = { argv: string[]; piped: boolean; heredoc?: string }

const PROTECTED = new Set(['main', 'master', 'production', 'prod', 'release', 'stable'])
const WRITE_METHODS = /^(POST|PUT|PATCH|DELETE)$/i
const SYSTEM_DIR = /^\/+(etc|usr|bin|sbin|System|Library|root|opt|boot|lib|lib64|private\/etc)(\/|$)|^\/+(private\/)?var\/(?!tmp\/|folders\/)/
const DEPTH = 4
const REDIRECTS = new Set(['>', '<', '<<'])

type Lex = { line: string; subs: string[]; out: Cmd[]; argv: string[]; w: string | undefined; piped: boolean; heredoc: string | undefined; delims: { word: string; strip: boolean }[] }

const word = (x: Lex) => { if (x.w !== undefined) x.argv.push(x.w); x.w = undefined }
const end = (x: Lex, pipe: boolean) => { word(x); if (x.argv.length) x.out.push({ argv: x.argv, piped: x.piped, ...x.heredoc !== undefined && { heredoc: x.heredoc } }); x.argv = []; x.piped = pipe; x.heredoc = undefined }
function sub(x: Lex, open: number): number {
  const { line } = x
  let depth = 0
  for (let j = open; j < line.length; j++) { if (line[j] === '(') depth++; else if (line[j] === ')' && --depth === 0) { x.subs.push(line.slice(open + 1, j)); return j } }
  x.subs.push(line.slice(open + 1))
  return line.length
}

function doubleQuoted(x: Lex, i: number): number {
  const { line } = x
  let s = ''
  for (i++; i < line.length && line[i] !== '"'; i++) {
    if (line[i] === '\\' && i + 1 < line.length) s += line[++i]
    else if (line[i] === '$' && line[i + 1] === '(') { const j = sub(x, i + 1); s += line.slice(i, j + 1); i = j }
    else if (line[i] === '`') { const j = line.indexOf('`', i + 1); x.subs.push(line.slice(i + 1, j < 0 ? undefined : j)); i = j < 0 ? line.length : j }
    else s += line[i]
  }
  x.w = (x.w ?? '') + s
  return i
}

function newline(x: Lex, i: number): number {
  const { line } = x
  let at = i + 1
  const bodies = x.delims.map(d => {
    const lines: string[] = []
    while (at < line.length) {
      const nl = line.indexOf('\n', at), l = line.slice(at, nl < 0 ? undefined : nl)
      at = nl < 0 ? line.length : nl + 1
      if ((d.strip ? l.replace(/^\t+/, '') : l) === d.word) break
      lines.push(l)
    }
    return lines.join('\n')
  })
  if (x.delims.length) { x.heredoc = bodies.join('\n'); x.delims.length = 0; i = at - 1 }
  end(x, false)
  return i
}

function heredocStart(x: Lex, i: number): number {
  const { line } = x
  word(x); i += 2
  const strip = line[i] === '-'
  if (strip) i++
  while (line[i] === ' ') i++
  let d = ''
  for (; i < line.length && !/[\s;&|<>()]/.test(line[i]!); i++) if (!`'"\\`.includes(line[i]!)) d += line[i]
  i--
  x.delims.push({ word: d, strip }); x.argv.push('<<')
  return i
}

function commands(line: string, subs: string[]): Cmd[] {
  const x: Lex = { line, subs, out: [], argv: [], w: undefined, piped: false, heredoc: undefined, delims: [] }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") { const j = line.indexOf("'", i + 1); x.w = (x.w ?? '') + line.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? line.length : j }
    else if (c === '"') i = doubleQuoted(x, i)
    else if (c === '\\') { if (line[i + 1] === '\n') i++; else x.w = (x.w ?? '') + (line[++i] ?? '') }
    else if (c === '#' && x.w === undefined) { const j = line.indexOf('\n', i); i = j < 0 ? line.length : j - 1 }
    else if (c === '\n') i = newline(x, i)
    else if (c === ' ' || c === '\t') word(x)
    else if (c === '|' && line[i + 1] !== '|') end(x, true)
    else if (';&|()`'.includes(c) || (c === '$' && line[i + 1] === '(')) { if (c === '$' || ((c === '&' || c === '|') && line[i + 1] === c)) i++; end(x, false) }
    else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') i = heredocStart(x, i)
    else if (c === '>' || c === '<') {
      if (/^\d$/.test(x.w ?? '')) x.w = undefined
      word(x)
      if (line[i + 1] === c || (c === '>' && line[i + 1] === '|')) i += c === '<' ? 2 : 1
      x.argv.push(c)
    }
    else x.w = (x.w ?? '') + c
  }
  end(x, false)
  return x.out
}

const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)
const flag = (a: string) => a.startsWith('-')
function skip(args: string[], from = 0, valued: string[] = []): number {
  let i = from
  while (i < args.length && flag(args[i]!)) i += valued.includes(args[i]!) ? 2 : 1
  return i
}
const after = (args: string[], valued: string[] = []) => args.slice(skip(args, 0, valued))
const positional = (args: string[], valued: string[] = []) => args.filter((a, i) => !flag(a) && !valued.includes(args[i - 1] ?? ''))
const short = (args: string[], letter: string) => args.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
const valuesOf = (args: string[], names: string[]) => args.flatMap((a, i) => names.includes(args[i - 1] ?? '') ? [a] : names.flatMap(n => a.startsWith(`${n}=`) ? [a.slice(n.length + 1)] : []))

const WRAPPERS: Record<string, string[]> = { env: ['-u', '-C', '-S'], nohup: [], time: [], command: [], exec: [], nice: ['-n'], busybox: [], stdbuf: [], npx: ['-p', '--package'],
  xargs: ['-n', '-I', '-P', '-L', '-s', '-d', '-E', '-a'], timeout: ['-s', '-k'], then: [], do: [], else: [], elif: [], if: [], while: [], until: [], '!': [], '{': [] }
const SSH_VALUED = ['-i', '-p', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B']
const EXEC_VALUED = ['-u', '--user', '-w', '--workdir', '-e', '--env', '--env-file', '--detach-keys', '--index', '--name', '--entrypoint', '-v', '--volume', '-p', '--publish', '-l', '--label']
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun'])
const DELETE_CODE = /\b(rmtree|rmSync|rm_r|rm_rf|unlinkSync|rmdirSync)\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\bfs\.(promises\.)?(rm|rmdir|unlink)\b/
const WEB_CODE = /\b(requests|httpx|session|axios)\.(post|put|patch|delete)\b|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|urlopen\([^)]*data=/i
const RUNS_CODE = /\b(os\.system|os\.popen|subprocess|child_process|execSync|spawn\w*|system)\s*\(|\bsubprocess\b|`/
const DB = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'clickhouse-client', 'cqlsh'])
const MONGO_WRITE = /\.(delete\w*|drop\w*|insert\w*|update\w*|replace\w*|remove|rename\w*|bulkWrite|create\w*)\s*\(/
const REDIS_READ = /^(get|mget|keys|scan|sscan|hscan|zscan|ttl|pttl|type|exists|hget|hmget|hgetall|hkeys|hvals|hlen|lrange|llen|lindex|smembers|scard|sismember|zrange|zrangebyscore|zscore|zcard|zcount|info|ping|dbsize|strlen|xrange|xrevrange|xlen|xinfo|memory|slowlog|latency|time|echo|randomkey|getrange|bitcount|pfcount|geopos|monitor|subscribe|psubscribe)$/i

function sqlWrites(sql: string): boolean {
  return sql.replace(/'[^']*'|"[^"]*"/g, '').replace(/--[^\n]*/g, '').split(';').some(st => {
    const s = st.trim().toLowerCase()
    return /^(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|replace|merge|call|lock|cluster|refresh|comment|reassign|load)\b/.test(s)
      || (/^\\?copy\b/.test(s) && !/\bto\s+stdout\b/.test(s)) || (/^with\b/.test(s) && /\b(insert|update|delete)\b/.test(s))
  })
}

const v = (words: string) => new RegExp(`^(?:${words})(?: |$)`)
const anywhere = (words: string) => new RegExp(`(?:^| )(?:${words})(?: |$)`)
const TOOLS: [string[], string[], RegExp, string][] = [
  [['kubectl', 'k', 'helm'], ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user'], v('apply|delete|rollout|scale|patch|replace|uninstall|install|upgrade|create|edit|drain|cordon|set|label|annotate|taint|rollback'), 'a deploy'],
  [['terraform', 'tofu'], ['-chdir'], v('apply|destroy|import|taint|untaint|force-unlock|state (rm|mv|push|replace-provider)|workspace delete'), 'an infrastructure change'],
  [['pulumi'], ['-s', '--stack', '-C', '--cwd'], v('up|destroy|import|refresh|cancel|state (delete|unprotect)|stack rm'), 'an infrastructure change'],
  [['systemctl', 'service', 'launchctl'], [], anywhere('stop|restart|disable|enable|kill|unload|bootout|reload|start|mask|isolate'), 'a service restart'],
  [['npm', 'pnpm', 'yarn', 'bun'], ['-w', '--workspace', '--filter', '--registry', '--prefix', '-C', '--cwd'], v('publish|unpublish|deprecate|npm publish|dist-tag (add|rm)|owner (add|rm)|run (deploy|release|publish)\\S*'), 'a package publish'],
  [['twine'], [], v('upload'), 'a package publish'], [['gem'], [], v('push|yank|owner'), 'a package publish'], [['cargo'], [], v('publish|yank|owner'), 'a package publish'],
  [['poetry', 'changeset', 'lerna'], [], v('publish'), 'a package publish'],
  [['fly', 'flyctl'], ['-a', '--app'], v('deploy|destroy|apps (destroy|restart)|scale|secrets|releases|machines? (stop|destroy|restart|kill|start)|volumes destroy'), 'a deploy'],
  [['vercel', 'netlify'], [], v('deploy|rm|remove|promote|rollback|env (add|rm)|domains (add|rm)'), 'a deploy'],
  [['wrangler'], [], v('deploy|publish|delete|rollback|secret (put|delete|bulk)|pages deploy|d1 (execute|migrations apply)|r2 (object|bucket) (put|delete)|kv (key )?(put|delete)|versions deploy'), 'a deploy'],
  [['heroku'], ['-a', '--app'], v('restart|ps:restart|ps:scale|ps:stop|pg:reset|pg:promote|releases:rollback|config:(set|unset)|apps:destroy|maintenance:on|run'), 'a deploy'],
  [['firebase'], [], v('deploy|hosting:disable|functions:delete|database:(set|update|remove|push)|firestore:delete'), 'a deploy'],
  [['serverless', 'sls'], [], v('deploy|remove|rollback'), 'a deploy'], [['cdk'], [], v('deploy|destroy'), 'a deploy'], [['sam'], [], v('deploy|delete|sync'), 'a deploy'],
  [['railway'], [], v('up|down|delete|redeploy|variables (set|delete)'), 'a deploy'], [['ansible-playbook'], [], /.?/, 'a deploy'],
  [['gcloud'], [], anywhere('deploy|delete|create|update|reset|stop|start|resize|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|import|rollback|cancel|patch'), 'a cloud change'],
  [['gsutil'], [], v('rm|mv|rb|cp|rsync|acl ch|iam ch|setmeta'), 'a cloud change'],
  [['az'], [], anywhere('delete|create|update|set|deploy|restart|stop|start|purge|add|remove|import|swap'), 'a cloud change'],
  [['alembic'], [], v('upgrade|downgrade|stamp'), 'a database write'], [['prisma'], [], v('migrate (deploy|reset|dev|resolve)|db (push|execute|seed)'), 'a database write'],
  [['supabase'], [], v('db (push|reset)|migration (up|repair)|functions deploy|secrets (set|unset)|projects delete'), 'a database write'],
  [['dropdb', 'dropuser', 'createdb', 'createuser', 'pg_restore'], [], /.?/, 'a database write'],
  [['reboot', 'shutdown', 'halt', 'poweroff'], [], /.?/, 'a shutdown'], [['shred', 'dd'], [], /.?/, 'erasing a disk or file'],
]
const BY_TOOL = new Map(TOOLS.flatMap(([names, valued, held, kind]) => names.map(n => [n, { valued, held, kind }] as const)))

function gitStep(args: string[]): string | undefined {
  const [sub = '', ...rest] = after(args, ['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
  if (sub === 'push') {
    if (rest.includes('--dry-run') || short(rest, 'n')) return undefined
    const forced = short(rest, 'f') || short(rest, 'd') || rest.some(a => /^--(force|delete|mirror|prune)/.test(a))
    const refs = positional(rest, ['-o', '--push-option', '--repo', '--receive-pack', '--exec']).slice(1)
    const dest = (r: string) => r.slice(r.indexOf(':') + 1).replace(/^\+/, '').replace(/^(refs\/)?heads\//, '')
    if (refs.some(r => PROTECTED.has(dest(r))) || (forced && !refs.slice(1).length && ['', 'HEAD', '@'].includes(dest(refs[0] ?? '')))) return 'a push to a protected branch'
    return forced || refs.some(r => r.startsWith('+') || r.startsWith(':')) ? 'a forced push or a branch delete' : undefined
  }
  const drops = (sub === 'reset' && rest.includes('--hard')) || (sub === 'clean' && (short(rest, 'f') || rest.includes('--force')))
    || (sub === 'branch' && (short(rest, 'D') || (short(rest, 'd') && short(rest, 'f')) || (rest.includes('--delete') && rest.includes('--force'))))
    || (sub === 'checkout' && (rest.includes('--') || short(rest, 'f') || rest.includes('--force') || positional(rest).includes('.')))
    || (sub === 'restore' && (!(rest.includes('--staged') || short(rest, 'S')) || rest.includes('--worktree') || short(rest, 'W')))
    || (sub === 'stash' && ['drop', 'clear'].includes(rest[0] ?? ''))
  return drops ? 'a git step that drops work' : undefined
}

function ghStep(args: string[]): string | undefined {
  const [a = '', b = '', ...rest] = after(args, ['-R', '--repo'])
  if ((a === 'pr' && b === 'merge') || (a === 'release' && /^(create|delete|edit|upload)$/.test(b)) || (a === 'repo' && /^(delete|edit|archive|rename)$/.test(b))
    || a === 'secret' || (a === 'variable' && /^(set|delete)$/.test(b)) || (a === 'workflow' && b === 'run')) return 'a GitHub merge, release, setting or workflow run'
  if (a !== 'api') return undefined
  const all = [b, ...rest]
  const method = [...valuesOf(all, ['-X', '--method']), ...all.flatMap(x => /^-X(.+)/.exec(x)?.slice(1, 2) ?? [])]
  if (method.some(m => WRITE_METHODS.test(m))) return 'a GitHub API change'
  const fields = valuesOf(all, ['-f', '-F', '--field', '--raw-field', '--input'])
  if (!fields.length || method.some(m => /^GET$/i.test(m))) return undefined
  return b !== 'graphql' || fields.some(f => /mutation/i.test(f) || f.includes('=@') || f.startsWith('@')) ? 'a GitHub API change' : undefined
}

function webStep(tool: string, args: string[]): string | undefined {
  const SENDS = 'a web request that sends or changes'
  if (tool === 'curl') {
    const method = [...valuesOf(args, ['--request']), ...args.flatMap((x, i) => /^-[a-zA-Z]*X$/.test(x) ? [args[i + 1] ?? ''] : /^-[a-zA-Z]*X(.+)/.exec(x)?.slice(1, 2) ?? [])]
    return method.some(m => WRITE_METHODS.test(m)) || args.some(a => /^-[a-zA-Z]*[dFT]/.test(a) || /^--(data|form|upload-file|json)/.test(a)) ? SENDS : undefined
  }
  if (tool === 'wget') return valuesOf(args, ['--method']).some(m => WRITE_METHODS.test(m)) || args.some(a => /^--(post-data|post-file|body-data|body-file)/.test(a)) ? SENDS : undefined
  const p = positional(args)
  return WRITE_METHODS.test(p[0] ?? '') || p.some(a => /^[\w.-]+:?=[^=]/.test(a)) ? SENDS : undefined
}

function dbStep(tool: string, rest: string[], argv: string[], piped: boolean, heredoc: string | undefined): string | undefined {
  const WRITE = 'a database write'
  if (tool === 'redis-cli') {
    const [cmd = '', next = ''] = positional(rest, ['-h', '-p', '-a', '-n', '-u', '--user', '--pass', '-s'])
    return cmd && !REDIS_READ.test(cmd) && !(/^config$/i.test(cmd) && /^get$/i.test(next)) ? WRITE : undefined
  }
  if (tool === 'mongo' || tool === 'mongosh') return valuesOf(rest, ['--eval']).some(e => MONGO_WRITE.test(e)) || piped || argv.includes('<') || MONGO_WRITE.test(heredoc ?? '') ? WRITE : undefined
  const sql = [...valuesOf(rest, ['-c', '--command', '-e', '--execute']), ...tool === 'sqlite3' ? positional(rest, ['-cmd', '-separator']).slice(1) : [], heredoc ?? '']
  return sqlWrites(sql.join(';')) || piped || argv.includes('<') || rest.some(a => /^(-f|--file)$/.test(a) || a.startsWith('--file=')) ? WRITE : undefined
}

const sys = (f: string) => SYSTEM_DIR.test(f)

function unwrap(argv: string[]): { tool: string; rest: string[] } {
  const args = argv.filter((a, i) => !REDIRECTS.has(a) && argv[i - 1] !== '>' && argv[i - 1] !== '<')
  let at = 0
  while (at < args.length && /^\w+=/.test(args[at]!)) at++
  for (let t = base(args[at] ?? ''); t in WRAPPERS && !(t === 'command' && /^-[vV]$/.test(args[at + 1] ?? '')); t = base(args[at] ?? '')) {
    at = skip(args, at + 1, WRAPPERS[t])
    if (t === 'env') while (at < args.length && /^\w+=/.test(args[at]!)) at++
    if (t === 'timeout') at++
  }
  return { tool: base(args[at] ?? ''), rest: args.slice(at + 1) }
}

function dockerStep(tool: string, rest: string[], inner: (x: string[]) => string | undefined): string | undefined {
  const [sub = '', ...more] = tool === 'docker-compose' ? ['compose', ...rest] : after(rest, ['-H', '--host', '--context', '-c', '--config', '-l', '--log-level'])
  const [cs = '', ...cm] = sub === 'compose' ? after(more, ['-f', '--file', '-p', '--project-name', '--env-file', '--profile', '--project-directory']) : []
  if (sub === 'exec' || cs === 'exec' || cs === 'run') { const x = after(sub === 'exec' ? more : cm, EXEC_VALUED); return x.length > 1 ? inner(x.slice(1)) : undefined }
  const changes = /^(rm|rmi|stop|kill|restart|push|prune)$/.test(sub) || /^(down|up|restart|rm|stop|kill|push)$/.test(cs)
    || (/^(system|volume|image|container|network)$/.test(sub) && /^(rm|prune)$/.test(more[0] ?? '')) || (/^(stack|service)$/.test(sub) && /^(deploy|rm|update|scale|rollback)$/.test(more[0] ?? ''))
  return changes ? 'a container change' : undefined
}

function step({ argv, piped, heredoc }: Cmd, depth: number): string | undefined {
  if (argv.some((_, i) => argv[i - 1] === '>' && sys(argv[i]!))) return 'a write to a system folder'
  const { tool, rest } = unwrap(argv)
  const inner = (x: string | string[]) => depth >= DEPTH ? 'a command nested too deep to read' : typeof x === 'string' ? check(x, depth + 1) : step({ argv: x, piped: false }, depth + 1)
  if (tool === 'sudo' || tool === 'doas') return 'a command as root'
  if (/^(cp|mv|install|ln|rsync)$/.test(tool) && positional(rest).length > 1 && sys(positional(rest).at(-1)!)) return 'a write to a system folder'
  if ((/^(rm|rmdir|unlink|truncate|touch|mkdir|tee|chmod|chown)$/.test(tool) || (tool === 'sed' && rest.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')))) && positional(rest).some(sys)) return 'a write to a system folder'
  if (tool === 'ssh') {
    let r = after(after(rest, SSH_VALUED).slice(1), SSH_VALUED)
    if (r[0] === '--') r = r.slice(1)
    if (!r.length || (SHELLS.has(base(r[0]!)) && !r.some(a => /^-[a-z]*c[a-z]*$/.test(a)))) return heredoc !== undefined ? inner(heredoc) : r.length && (piped || argv.includes('<')) ? 'a script run on another machine' : undefined
    return inner(r.join(' '))
  }
  if (SHELLS.has(tool)) { const i = rest.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a)); return i >= 0 && rest[i + 1] ? inner(rest[i + 1]!) : heredoc !== undefined ? inner(heredoc) : undefined }
  if (tool === 'eval') return inner(rest.join(' '))
  if (INTERPRETERS.has(tool)) {
    if (/(^|\/)manage\.py$/.test(rest[0] ?? '') && /^(migrate|flush|loaddata|sqlflush)$/.test(rest[1] ?? '')) return 'a database write'
    const code = valuesOf(rest, ['-c', '-e', '--eval']).join('\n')
    if (DELETE_CODE.test(code)) return 'a forced or recursive delete'
    if (WEB_CODE.test(code)) return 'a web request that sends or changes'
    if (RUNS_CODE.test(code)) for (const m of code.matchAll(/'([^']*)'|"([^"]*)"/g)) { const held = inner(m[1] ?? m[2] ?? ''); if (held) return held }
    return undefined
  }
  if (tool === 'rm') return rest.some(a => /^-[a-zA-Z]*[rRf]/.test(a) || a === '--recursive' || a === '--force') ? 'a forced or recursive delete' : undefined
  if (tool === 'find') return rest.includes('-delete') || rest.some((a, i) => (a === '-exec' || a === '-execdir') && base(rest[i + 1] ?? '') === 'rm') ? 'a forced or recursive delete' : undefined
  if (tool === 'rsync') return rest.some(a => a.startsWith('--delete')) ? 'a forced or recursive delete' : undefined
  if (tool.startsWith('mkfs')) return 'erasing a disk or file'
  if (tool === 'git') return gitStep(rest)
  if (tool === 'gh') return ghStep(rest)
  if ((tool === 'kubectl' || tool === 'k') && positional(rest)[0] === 'exec') { const i = rest.indexOf('--'); return i >= 0 ? inner(rest.slice(i + 1)) : undefined }
  if (tool === 'docker' || tool === 'podman' || tool === 'docker-compose') return dockerStep(tool, rest, inner)
  const rule = BY_TOOL.get(tool)
  if (rule) return rule.held.test(positional(after(rest, rule.valued), rule.valued).join(' ')) || (tool === 'vercel' && (rest.includes('--prod') || !positional(rest).length)) ? rule.kind : undefined
  if (tool === 'aws') {
    const valued = ['--profile', '--region', '--output', '--endpoint-url', '--query', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout']
    const [, op = ''] = positional(after(rest, valued), valued)
    return /^(rm|mv|cp|sync|rb)$|delete|terminate|put|update|create|modify|remove|attach|detach|stop|start|reboot|run|send|publish|invoke|register|revoke|authorize|restore|rotate|deploy|purge|change|batch-write|schedule|execute/.test(op) ? 'an AWS change' : undefined
  }
  if (tool === 'kill') return rest.some(a => /^(%?\d+|\$\S+)$/.test(a)) && !rest.includes('-0') && !rest.includes('-l') ? 'stopping a process' : undefined
  if (tool === 'pkill' || tool === 'killall') return !rest.includes('-0') && positional(rest).length ? 'stopping a process' : undefined
  if (DB.has(tool) || tool === 'redis-cli' || tool === 'mongo' || tool === 'mongosh') return dbStep(tool, rest, argv, piped, heredoc)
  if (/^(curl|wget|http|https|xh|xhs)$/.test(tool)) return webStep(tool, rest)
  if (/^(sendmail|mailx|mutt|mail|msmtp)$/.test(tool)) return positional(rest).some(a => a.includes('@')) ? 'an email' : undefined
  if (tool === 'stripe') return positional(rest).slice(1).some(a => /^(create|update|delete|cancel|refund|capture|pay)$/.test(a)) ? 'a money step' : undefined
  if (tool === 'chmod' || tool === 'chown') return short(rest, 'R') || rest.includes('--recursive') ? 'a recursive permission change' : undefined
  if (tool === 'crontab') return rest.some(a => a === '-r' || a === '-e') || positional(rest).length ? 'a cron change' : undefined
  return undefined
}

function check(line: string, depth: number): string | undefined {
  const subs: string[] = []
  for (const c of commands(line, subs)) { const held = step(c, depth); if (held) return held }
  for (const s of subs) { const held = depth < DEPTH ? check(s, depth + 1) : 'a command nested too deep to read'; if (held) return held }
  return undefined
}

export const heldCommand = (command: string): string | undefined => check(command, 0)
