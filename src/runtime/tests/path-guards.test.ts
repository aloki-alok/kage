import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentReadRefusal, certFileEnv, configRefusal, dreamNoteRefusal, protectConfig, ownerMemoryRefusal, toolRefusal } from '../path-guards.ts'

describe("the owner's memory takes only people notes", () => {
  const MEM = '/home/o/.claude/projects/-home-o/memory'
  const ok = (tool: string, file_path: string) => assert.equal(ownerMemoryRefusal(tool, { file_path }, MEM), undefined, `${tool} ${file_path}`)
  const no = (tool: string, file_path: string) => assert.match(ownerMemoryRefusal(tool, { file_path }, MEM) ?? '', /people notes/, `${tool} ${file_path}`)
  test('a note about a person may be written', () => { ok('Write', `${MEM}/user_sam.md`); ok('Edit', `${MEM}/user_sam.md`) })
  test('the index may be edited, never overwritten', () => { ok('Edit', `${MEM}/MEMORY.md`); no('Write', `${MEM}/MEMORY.md`) })
  test('any other memory of the owner is read-only', () => {
    no('Write', `${MEM}/feedback_x.md`); no('Edit', `${MEM}/project_y.md`); no('MultiEdit', `${MEM}/sub/user_z.md`)
    no('Write', `${MEM}/../memory/feedback_x.md`)
  })
  test('another spelling of the same folder is still the owner memory: case, ~, a notebook path', () => {
    no('Write', `${MEM.toUpperCase()}/FEEDBACK_X.md`)
    assert.match(ownerMemoryRefusal('Write', { file_path: '~/.claude/projects/-home-o/memory/feedback_x.md' }, MEM, undefined, '/home/o') ?? '', /people notes/)
    assert.match(ownerMemoryRefusal('NotebookEdit', { notebook_path: `${MEM}/x.ipynb` }, MEM) ?? '', /people notes/)
  })
  test('a link that points into the owner memory is followed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kage-guard-'))
    const mem = join(root, 'memory')
    mkdirSync(mem)
    writeFileSync(join(mem, 'feedback_x.md'), 'x')
    symlinkSync(join(mem, 'feedback_x.md'), join(root, 'link.md'))
    symlinkSync(mem, join(root, 'dirlink'))
    assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'link.md') }, mem) ?? '', /people notes/)
    assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'new_feedback.md') }, mem) ?? '', /people notes/)
    assert.equal(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'user_bob.md') }, mem), undefined)
  })
  test("Kage's own memory and other files are free, and reads are never blocked", () => {
    ok('Write', '/home/o/.config/kage/memory/feedback_x.md'); ok('Write', '/tmp/x.md')
    assert.equal(ownerMemoryRefusal('Read', { file_path: '/home/o/.config/kage/memory/feedback_x.md' }, MEM, 'teammate'), undefined)
  })
})

describe("a task not from the owner reads only people notes in the owner's memory (#228)", () => {
  const MEM = '/home/o/.claude/projects/-home-o/memory'
  const read = (sender: string | undefined, tool: string, key: string, path: string, home?: string) => ownerMemoryRefusal(tool, { [key]: path }, MEM, sender, home)
  test('a teammate or voice Read, Grep or Glob of other memory is refused', () => {
    for (const sender of ['teammate', 'voice', undefined]) {
      assert.match(read(sender, 'Read', 'file_path', `${MEM}/feedback_x.md`) ?? '', /people notes/, `${sender} Read`)
      assert.match(read(sender, 'Grep', 'path', MEM) ?? '', /people notes/, `${sender} Grep`)
      assert.match(read(sender, 'Glob', 'path', MEM) ?? '', /people notes/, `${sender} Glob`)
      assert.match(read(sender, 'Glob', 'pattern', `${MEM}/*.md`) ?? '', /people notes/, `${sender} Glob pattern`)
    }
  })
  test('absolute, ~ and case-changed spellings are refused', () => {
    assert.match(read('teammate', 'Read', 'file_path', '~/.claude/projects/-home-o/memory/project_y.md', '/home/o') ?? '', /people notes/)
    assert.match(read('teammate', 'Read', 'file_path', `${MEM.toUpperCase()}/PROJECT_Y.MD`) ?? '', /people notes/)
    assert.match(read('teammate', 'Read', 'file_path', `${MEM}/../memory/project_y.md`) ?? '', /people notes/)
  })
  test('a link into the owner memory is followed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kage-guard-'))
    const mem = join(root, 'memory')
    mkdirSync(mem)
    symlinkSync(mem, join(root, 'dirlink'))
    assert.match(ownerMemoryRefusal('Read', { file_path: join(root, 'dirlink', 'project_y.md') }, mem, 'teammate') ?? '', /people notes/)
  })
  test('people notes stay readable; the index, which names every project, does not', () => {
    assert.equal(read('teammate', 'Read', 'file_path', `${MEM}/user_sam.md`), undefined)
    assert.match(read('teammate', 'Read', 'file_path', `${MEM}/MEMORY.md`) ?? '', /people notes/)
  })
  test('a search from a folder above the memory is refused: no path (the home folder), the home folder, or a glob from there', () => {
    const search = (tool: string, input: Record<string, string>) => ownerMemoryRefusal(tool, input, MEM, 'teammate', '/home/o', '/home/o')
    assert.match(search('Grep', { pattern: 'token' }) ?? '', /outside/)
    assert.match(search('Grep', { pattern: 'token', path: '/home/o' }) ?? '', /outside/)
    assert.match(search('Glob', { pattern: '**/*.md' }) ?? '', /outside/)
    assert.match(search('Glob', { pattern: '/home/o/.claude/**/*.md' }) ?? '', /outside/)
    assert.equal(search('Grep', { pattern: 'token', path: '/home/o/code' }), undefined)
    assert.match(search('Glob', { path: '/tmp', pattern: `${MEM}/*.md` }) ?? '', /people notes|outside/, 'an absolute pattern wins over path')
    assert.match(search('Glob', { path: '/home/o/code', pattern: '../.claude/projects/-home-o/memory/*.md' }) ?? '', /people notes|outside/, '.. in a pattern')
    assert.equal(ownerMemoryRefusal('Grep', { pattern: 'token' }, MEM, 'owner', '/home/o', '/home/o'), undefined)
  })
  test("the owner's own task reads anything", () => {
    assert.equal(read('owner', 'Read', 'file_path', `${MEM}/feedback_x.md`), undefined)
    assert.equal(read('owner', 'Grep', 'path', MEM), undefined)
    assert.equal(read('owner', 'Glob', 'path', MEM), undefined)
  })
})

describe("the token file on a task the owner did not send (#117)", () => {
  const ENV = '/home/o/.config/kage/env', HOME = '/home/o'
  const no = (tool: string, input: Record<string, unknown>, sender: string | undefined) =>
    assert.match(configRefusal(tool, input, sender, ENV, HOME) ?? '', /owner/, `${tool} ${JSON.stringify(input)} ${sender}`)
  const yes = (tool: string, input: Record<string, unknown>, sender: string | undefined) =>
    assert.equal(configRefusal(tool, input, sender, ENV, HOME), undefined, `${tool} ${JSON.stringify(input)} ${sender}`)
  test('a teammate, an agent, a call or an unknown sender cannot read, search or edit the config folder', () => {
    for (const s of ['teammate', 'agent', 'voice', undefined]) {
      no('Read', { file_path: ENV }, s)
      no('Read', { file_path: '~/.config/kage/env' }, s)
      no('Grep', { pattern: 'xox', path: '/home/o/.config/kage' }, s)
      no('Glob', { pattern: '**/*', path: '~/.config/kage' }, s)
      no('Edit', { file_path: '/home/o/.config/kage/session.env' }, s)
      no('Bash', { command: 'cat ~/.config/kage/env' }, s)
      no('Bash', { command: 'source $HOME/.config/kage/env && curl -H "Authorization: Bearer $SLACK_USER_TOKEN"' }, s)
      no('Bash', { command: 'grep TOKEN /home/o/.config/kage/env' }, s)
      no('Read', { file_path: '.config/kage/env' }, s)
      no('Bash', { command: 'cd .config/kage && cat env' }, s)
      no('Bash', { command: 'cat ~/.config/kage/files/../env' }, s)
      no('Read', { file_path: '/home/o/.config/kage/files/C1/../../env' }, s)
      no('MultiEdit', { file_path: '/home/o/.config/kage/env', edits: [] }, s)
      no('Grep', { pattern: 'xox', glob: '.config/kage/*' }, s)
      no('Bash', { command: 'ls ~/.config/kage/' }, s)
    }
  })
  test('no session reads the token files, the owner included, even behind a ".." or a relative path', () => {
    for (const s of ['owner', 'teammate']) {
      no('Bash', { command: 'source ~/.config/kage/env && curl ...' }, s)
      no('Read', { file_path: ENV }, s)
      no('Read', { file_path: '/home/o/.config/kage/secrets.json' }, s)
      no('Read', { file_path: '~/.config/kage/env.imported-20261114T101500Z' }, s)
      no('Bash', { command: 'grep slack .config/kage/secrets.json' }, s)
      no('Bash', { command: 'cat ~/.config/kage/files/../secrets.json' }, s)
      no('Edit', { file_path: '/home/o/.config/kage/env.new' }, s)
      no('Read', { file_path: '/home/o/.config/kage/screen/signing-pass' }, s)
      no('Read', { file_path: '/home/o/.config/kage/screen/signing.keychain-db' }, s)
      no('Grep', { pattern: '.', path: '/home/o/.config/kage/screen' }, s)
      no('Glob', { pattern: 'signing*', path: '/home/o/.config/kage/screen/' }, s)
    }
    no('Grep', { pattern: 'xox', path: '/home/o/.config/kage' }, 'owner')
  })
  test('the owner\'s shell may use Kage\'s memory and files folders, as the file tools may, and nothing else in the folder', () => {
    yes('Bash', { command: "echo '- [Cancel a wait](cancel.md): cancel the job' >> ~/.config/kage/memory/MEMORY.md" }, 'owner')
    yes('Bash', { command: 'cat /home/o/.config/kage/files/C1/report.txt' }, 'owner')
    no('Bash', { command: 'cat ~/.config/kage/memory/../secrets.json' }, 'owner')
    no('Bash', { command: 'cat ~/.config/kage/memory/x ~/.config/kage/kage.db' }, 'owner')
    no('Bash', { command: 'ls ~/.config/kage/' }, 'owner')
  })
  test('the owner may read and edit config.json and the folder listing', () => {
    yes('Read', { file_path: '/home/o/.config/kage/config.json' }, 'owner')
    yes('Read', { file_path: '/home/o/.config/kage/./config.json' }, 'owner')
    yes('Grep', { pattern: 'x', path: '/home/o/.config/kage/config.json' }, 'owner')
  })
  test('other files and commands are fine for a teammate', () => {
    yes('Read', { file_path: '/home/o/kage/README.md' }, 'teammate')
    yes('Bash', { command: 'kage status' }, 'teammate')
    yes('Grep', { pattern: 'env', path: '/home/o/kage' }, 'teammate')
    yes('mcp__kage__reply', { text: 'see ~/.config/kage/env' }, 'teammate')
    yes('Bash', { command: 'python3 run.py /home/o/.config/kage/files/C1_5.5' }, 'teammate')
    yes('Read', { file_path: '~/.config/kage/files/C1_5.5/out.csv' }, 'teammate')
    no('Bash', { command: 'cp ~/.config/kage/files/C1_5.5/x ~/.config/kage/env' }, 'teammate')
    yes('Bash', { command: 'ls ~/.config/kage/files' }, 'teammate')
    yes('Read', { file_path: '/home/o/.config/kage/memory/MEMORY.md' }, 'teammate')
    yes('Write', { file_path: '~/.config/kage/memory/x.md', content: 'the env file is ~/.config/kage/env' }, 'teammate')
    yes('Read', { file_path: '/home/o/.config/kage-x/notes.md' }, 'teammate')
  })
})

describe('the token files behind every path form, and config.json closed to writes (#116 review)', () => {
  const ENV = '/home/o/.config/kage/env', HOME = '/home/o'
  const no = (tool: string, input: Record<string, unknown>, sender: string | undefined) =>
    assert.match(configRefusal(tool, input, sender, ENV, HOME) ?? '', /owner|closed/, `${tool} ${JSON.stringify(input)} ${sender}`)
  test('the owner cannot reach secrets.json or env* by ./, //, cd, a glob, or a search of the folder', () => {
    no('Read', { file_path: '/home/o/.config/kage/./secrets.json' }, 'owner')
    no('Read', { file_path: '/home/o/.config//kage//secrets.json' }, 'owner')
    no('Read', { file_path: '/home/o/.config/kage/env.new' }, 'owner')
    no('Bash', { command: 'cd ~/.config/kage && cat secrets.json' }, 'owner')
    no('Bash', { command: 'cat ~/.config/kage/*' }, 'owner')
    no('Bash', { command: 'cat ~/.config/kage/sec*' }, 'owner')
    no('Bash', { command: 'cat ~/.config/kage/./secrets.json' }, 'owner')
    no('Bash', { command: 'cat "$HOME/.config//kage/secrets.json"' }, 'owner')
    no('Glob', { pattern: '*', path: '/home/o/.config/kage' }, 'owner')
    no('Glob', { pattern: '/home/o/.config/kage/*' }, 'owner')
    no('Grep', { pattern: 'xox', path: '/home/o/.config/kage/.' }, 'owner')
    no('Read', { file_path: '/home/o/.config/kage/s*.json' }, 'owner')
  })
  test('the owner cannot read, search or write session.env or the waha folder by a file tool (the tmux route has only this hook)', () => {
    for (const t of ['Read', 'Write', 'Edit']) for (const f of ['session.env', 'session.env.bak', 'waha/.env', 'waha']) no(t, { file_path: `/home/o/.config/kage/${f}` }, 'owner')
    no('Grep', { pattern: 'KEY', path: '/home/o/.config/kage/session.env' }, 'owner')
    no('Grep', { pattern: 'KEY', path: '/home/o/.config/kage/waha' }, 'owner')
  })
  test('no session writes config.json, secrets.json or an env file by any tool', () => {
    for (const s of ['owner', 'teammate', undefined]) {
      no('Edit', { file_path: '/home/o/.config/kage/config.json' }, s)
      no('Write', { file_path: '~/.config/kage/./config.json', content: '{}' }, s)
      no('MultiEdit', { file_path: '/home/o/.config//kage/config.json', edits: [] }, s)
      no('Bash', { command: 'echo {} > ~/.config/kage/config.json' }, s)
    }
  })
})

describe('harness.sandbox: off by default, the file rules stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-nosandbox-'))
  test('with no setting a session gets no OS sandbox, so its shell works like the owner\'s terminal', () => {
    assert.equal('sandbox' in protectConfig(`${dir}/env`, dir, '/home/o'), false)
  })
  test('the token files stay closed to the file tools with the sandbox off', () => {
    const w = protectConfig(`${dir}/env`, dir, '/home/o')
    for (const n of ['secrets.json', 'session.env']) assert.ok(w.permissions.deny.includes(`Read(/${realpathSync(dir)}/${n})`), n)
  })
  test('on, it is the wall every session had before', () => {
    assert.equal(protectConfig(`${dir}/env`, dir, '/home/o', true).sandbox?.enabled, true)
  })
})

describe('protectConfig: what the sandbox and the file rules close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-protect-'))
  const code = mkdtempSync(join(tmpdir(), 'kage-code-'))
  for (const f of ['config.json', 'secrets.json', 'afk.json', 'hub.log']) writeFileSync(join(dir, f), '')
  for (const d of ['files', 'memory', 'sender']) mkdirSync(join(dir, d))
  const w = protectConfig(`${dir}/env`, code, '/home/o', true)
  const real = (p: string) => realpathSync(p)
  test('a shell may not write anything in the config folder but files/ and memory/, whether or not it exists yet', () => {
    const deny = w.sandbox!.filesystem.denyWrite
    for (const n of ['session.env', 'kagelets', 'config.json*', 'secrets.json*', 'env*', 'afk.json', 'hub.log', 'sender']) assert.ok(deny.includes(`${real(dir)}/${n}`), n)
    for (const n of ['files', 'memory']) assert.ok(!deny.some(d => d === `${real(dir)}/${n}` || d === real(dir)), n)
  })
  test('a tools: all kagelet: its file tools cannot edit Kage\'s code or the login folders, and only gpg and the ssh agent keep their sockets', () => {
    const was = { gnupg: process.env.GNUPGHOME, ssh: process.env.SSH_AUTH_SOCK }
    process.env.GNUPGHOME = '/g/home'; process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    try {
      const k = protectConfig(`${dir}/env`, code, '/home/o', 'kagelet')
      for (const p of [`Edit(/${code}/**)`, 'Edit(//home/o/Library/LaunchAgents/**)', 'Edit(//home/o/.config/systemd/**)']) assert.ok(k.permissions.deny.includes(p), p)
      assert.deepEqual(k.sandbox!.network.allowUnixSockets, ['/g/home', '/tmp/agent.sock'])
      assert.equal(k.sandbox!.network.allowAllUnixSockets, false)
      assert.ok(!w.permissions.deny.some(p => p.includes(code)))
    } finally { process.env.GNUPGHOME = was.gnupg; process.env.SSH_AUTH_SOCK = was.ssh; if (was.gnupg === undefined) delete process.env.GNUPGHOME; if (was.ssh === undefined) delete process.env.SSH_AUTH_SOCK }
  })
  test('no session reads session.env or the waha key file, though only secrets.json and env* were named before', () => {
    const read = w.sandbox!.filesystem.denyRead
    for (const n of ['secrets.json*', 'env*', 'session.env*', 'waha/.env*']) assert.ok(read.includes(`${real(dir)}/${n}`), n)
    for (const n of ['session.env', 'waha/.env']) assert.ok(w.permissions.deny.includes(`Read(/${real(dir)}/${n})`), n)
    for (const n of ['session.env', 'waha/.env']) assert.ok(w.permissions.deny.includes(`Edit(/${real(dir)}/${n})`), n)
  })
  test("the owner's Write and Edit tools reach memory/ and its ledger (the dream job's route), not the token files", () => {
    const at = (tool: string, f: string) => configRefusal(tool, { file_path: `${real(dir)}/${f}` }, 'owner', `${dir}/env`, '/home/o')
    for (const t of ['Write', 'Edit']) for (const f of ['memory/.dream-ledger.tsv', 'memory/MEMORY.md', 'memory/a.md']) assert.equal(at(t, f), undefined, `${t} ${f}`)
    for (const f of ['secrets.json', 'env', 'config.json']) assert.ok(at('Write', f), f)
    assert.equal(configRefusal('Glob', { path: `${real(dir)}/memory`, pattern: '**/*' }, 'owner', `${dir}/env`, '/home/o'), undefined)
    assert.equal(configRefusal('Glob', { path: `${real(dir)}/memory`, pattern: '.archive/*' }, 'owner', `${dir}/env`, '/home/o'), undefined)
  })
  test('a name the hub reads when it is absent (crons-import.json, waha, threads.json) cannot be created, though the folder lacks it now', () => {
    const deny = w.sandbox!.filesystem.denyWrite
    for (const n of ['crons-import.json*', 'waha', 'threads.json*', 'afk.json*', 'github-threads.json*', 'mail-threads.json*', 'kage.db*', 'hub.lock', 'router.sock']) assert.ok(deny.includes(`${real(dir)}/${n}`), n)
  })
  test('every name the code builds under the config folder with ${DIR}/, ${CONF}/ or ${o.dir}/ is on that list or is files/ or memory/', () => {
    const root = new URL('../../../', import.meta.url).pathname
    const names = w.sandbox!.filesystem.denyWrite.map(d => d.split('/').pop()!)
    const covered = (n: string) => names.some(d => d === n || (d.endsWith('*') && n.startsWith(d.slice(0, -1))))
    const seen = new Set<string>()
    for (const f of execFileSync('git', ['ls-files', '*.ts', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !f.includes('tests/'))) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/\$\{(?:DIR|CONF|o\.dir)\}\/([A-Za-z0-9_.*-]+)/g)) seen.add(m[1]!.replace(/\.$/, ''))
    }
    const open = new Set(['files', 'memory', 'plugin/server.ts', 'node_modules', 'package-lock.json', 'browser-pair.sh', 'version', 'status', 'standin'])
    const missing = [...seen].filter(n => !covered(n) && !open.has(n))
    assert.deepEqual(missing, [], 'add these to CONFIG_NAMES in runtime/path-guards.ts, or to the open list here if a session needs to write them')
  })
  test('the hub code folder and the files the OS reads at login are closed to writes too', () => {
    const deny = w.sandbox!.filesystem.denyWrite
    assert.ok(deny.includes(real(code)))
    assert.ok(deny.includes('/home/o/Library/LaunchAgents') && deny.includes('/home/o/.config/systemd'))
  })
  test('the file rules use Edit, which covers Write, and the sandbox must start', () => {
    assert.ok(w.permissions.deny.every(r => !r.startsWith('Write(')))
    assert.ok(w.permissions.deny.includes(`Edit(/${real(dir)}/config.json)`))
    assert.equal(w.sandbox!.failIfUnavailable, true)
  })
})

describe('Go tools verify TLS inside the macOS sandbox (#226)', () => {
  const has = () => true
  test('a mac session reads certificates from the system file, since the sandbox blocks the trust service', () => {
    assert.deepEqual(certFileEnv('darwin', {}, has), { SSL_CERT_FILE: '/etc/ssl/cert.pem' })
  })
  test("the owner's own setting wins, Linux needs nothing, and a missing file sets nothing", () => {
    assert.deepEqual(certFileEnv('darwin', { SSL_CERT_FILE: '/mine.pem' }, has), {})
    assert.deepEqual(certFileEnv('linux', {}, has), {})
    assert.deepEqual(certFileEnv('darwin', {}, () => false), {})
  })
})

describe("an agent's task reads no secrets", () => {
  const home = mkdtempSync(join(tmpdir(), 'kage-agent-'))
  mkdirSync(join(home, '.config/kage'), { recursive: true })
  writeFileSync(join(home, '.config/kage/secrets.json'), '{}')
  mkdirSync(join(home, 'work'), { recursive: true })
  symlinkSync(join(home, '.config/kage/secrets.json'), join(home, 'work/notes.txt'))
  const refuse = (tool: string, input: Record<string, string>) => agentReadRefusal(tool, input, 'agent', home)
  test('a read of a place that holds secrets is refused, through a symlink and for a path that does not exist yet', () => {
    for (const p of ['.config/kage/secrets.json', '.ssh/id_ed25519', '.aws/credentials', '.claude/settings.json', 'work/.env', 'work/.env.production', 'work/server.pem', 'work/notes.txt'])
      assert.match(refuse('Read', { file_path: join(home, p) }) ?? '', /secrets/, p)
    assert.match(refuse('Grep', { path: join(home, '.aws') }) ?? '', /secrets/)
    assert.match(refuse('Glob', { pattern: '**/.env*' }) ?? '', /secrets/)
    assert.match(refuse('Glob', { pattern: '.config/kage/*' }) ?? '', /secrets/)
  })
  test('ordinary reads pass, and only an agent is checked', () => {
    assert.equal(refuse('Read', { file_path: join(home, 'work/README.md') }), undefined)
    assert.equal(refuse('Grep', { path: join(home, 'work') }), undefined)
    assert.equal(agentReadRefusal('Read', { file_path: join(home, '.ssh/id_ed25519') }, 'teammate', home), undefined)
  })
})

describe("the dream writes no new note itself: new lessons go through dream_lessons (#488)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-own-'))
  writeFileSync(join(dir, 'old.md'), 'x')
  test('a new note is refused; an existing note, the index and the archive stay open for tidying', () => {
    assert.match(dreamNoteRefusal('Write', { file_path: join(dir, 'new-lesson.md') }, dir) ?? '', /dream_lessons/)
    assert.match(dreamNoteRefusal('Write', { file_path: join(dir, 'sub', 'new.md') }, dir) ?? '', /dream_lessons/)
    for (const f of ['old.md', 'MEMORY.md', '.dream-ledger.tsv', '.archive/old.md']) assert.equal(dreamNoteRefusal('Write', { file_path: join(dir, f) }, dir), undefined, f)
    assert.equal(dreamNoteRefusal('Edit', { file_path: join(dir, 'old.md') }, dir), undefined)
    assert.equal(dreamNoteRefusal('Write', { file_path: '/tmp/elsewhere.md' }, dir), undefined)
    assert.equal(dreamNoteRefusal('Read', { file_path: join(dir, 'new.md') }, dir), undefined)
    assert.match(dreamNoteRefusal('Bash', { command: `echo x > ${dir}/n.md` }, dir) ?? '', /dream_lessons/)
    assert.match(dreamNoteRefusal('Bash', { command: `cat ${realpathSync(dir)}/old.md` }, dir) ?? '', /dream_lessons/)
    assert.equal(dreamNoteRefusal('Bash', { command: 'ls /tmp' }, dir), undefined)
  })
})

describe("the owner's own task may fix the owner's memory", () => {
  const root = mkdtempSync(join(tmpdir(), 'kage-owner-mem-'))
  const mem = join(root, 'memory')
  mkdirSync(mem)
  writeFileSync(join(mem, 'feedback_x.md'), 'x')
  const as = (sender: string | undefined, tool: string, name: string, side = false) =>
    toolRefusal(tool, { file_path: join(mem, name) }, sender, { ownerMemory: mem, envFile: join(root, 'cfg', 'env'), side })
  test('an Edit or MultiEdit of a note that exists passes', () => {
    assert.equal(as('owner', 'Edit', 'feedback_x.md'), undefined)
    assert.equal(as('owner', 'MultiEdit', 'feedback_x.md'), undefined)
  })
  test('a Write over a note that exists passes, a Write of a new note is refused', () => {
    assert.equal(as('owner', 'Write', 'feedback_x.md'), undefined)
    assert.match(as('owner', 'Write', 'project_y.md') ?? '', /people notes.*Kage's memory/)
    assert.match(as('owner', 'Edit', 'project_y.md') ?? '', /people notes/)
  })
  test('every other sender keeps the old rule', () => {
    for (const sender of ['teammate', 'trusted', undefined]) assert.match(as(sender, 'Edit', 'feedback_x.md') ?? '', /people notes/, String(sender))
    for (const sender of ['agent', 'voice']) assert.ok(as(sender, 'Edit', 'feedback_x.md'), sender)
  })
  test('a side lane such as the dream stays read only, though it runs as the owner', () => {
    assert.match(as('owner', 'Edit', 'feedback_x.md', true) ?? '', /people notes/)
    assert.match(as('owner', 'Write', 'feedback_x.md', true) ?? '', /people notes/)
  })
})

describe('a session may not run the command a secret names (#158)', () => {
  const folder = (secrets: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-secret-cmd-'))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets))
    return { ownerMemory: join(dir, 'memory'), envFile: join(dir, 'env') }
  }
  const bash = (o: { ownerMemory: string; envFile: string }, command: string, sender = 'owner') => toolRefusal('Bash', { command }, sender, o)

  test('with a command-backed secret, its command and the secret helpers are refused where a command starts, for the owner too', () => {
    const o = folder({ slack: { bot: { command: 'op read op://kage/slack-bot' } }, jevKey: { command: '/usr/local/bin/kage-token jev' }, voiceToken: { command: '/opt/bin/pw' } })
    for (const c of ['op read op://kage/slack-bot', 'echo $(op  read   op://kage/slack-bot)', 'op read op://other/item', 'op item get kage', 'op --account me read op://x', 'op document get x', 'op inject -i t.tpl', 'op run -- env',
      'security find-generic-password -w -s kage', 'security -q find-internet-password -s x', 'security dump-keychain -d', 'pass show kage/bot', 'pass kage/bot', 'pass -c kage/bot', 'pass otp kage/bot', 'gopass show kage/bot', 'lpass show x', 'secret-tool lookup s k', 'bw get password x',
      'X=1 /usr/local/bin/kage-token   jev | cat', 'kage-token jev', "kage-token 'jev'", "'/usr/local/bin/kage-token' jev", 'kage-token \\\n jev', 'sh -c "op read x"', 'eval "$(op read x)"', 'X=1 op read x', 'ls; pw'])
      assert.match(bash(o, c) ?? '', /secret/, c)
    assert.match(bash(o, 'op read op://kage/slack-bot', 'teammate') ?? '', /secret/)
    for (const c of ['ls -la', 'git status', 'pwd', 'echo operator read', 'security list-keychains', 'npm test -- --pass-with-no-tests', 'echo tests pass', 'pass ls', 'grep -rn "op read" src/', 'rg "pass show" docs',
      'git log --grep "security find-generic-password"', 'git commit -m "no-op run when idle"', 'git commit -m "make lint pass src/x.ts"', 'mysql --pass foo/bar', 'echo "op inject docs"', 'ls ~/opt/bin/pwd'])
      assert.equal(bash(o, c), undefined, c)
    assert.equal(toolRefusal('Read', { file_path: '/tmp/op read' }, 'owner', o), undefined)
  })

  test('with no command-backed secret, the helpers run as before', () => {
    const o = folder({ slack: { bot: 'xoxb-fake' } })
    for (const c of ['op read op://kage/slack-bot', 'security find-generic-password -w -s kage', 'pass show x']) assert.equal(bash(o, c), undefined, c)
  })
})

describe('the owner key is closed like secrets.json', () => {
  const ENV = '/home/o/.config/kage/env', HOME = '/home/o'
  const dir = mkdtempSync(join(tmpdir(), 'kage-okey-guard-'))
  const code = mkdtempSync(join(tmpdir(), 'kage-code-'))
  const real = realpathSync(dir)
  test('no session reads, searches or writes owner.key by a file tool or a named shell path, the owner included', () => {
    for (const s of ['owner', 'teammate', undefined]) {
      for (const t of ['Read', 'Write', 'Edit']) assert.match(configRefusal(t, { file_path: '/home/o/.config/kage/owner.key' }, s, ENV, HOME) ?? '', /owner|closed/, `${t} ${s}`)
      assert.match(configRefusal('Bash', { command: 'cat ~/.config/kage/owner.key' }, s, ENV, HOME) ?? '', /owner|closed/, `Bash ${s}`)
      assert.match(configRefusal('Grep', { pattern: '.', path: '/home/o/.config/kage/owner.key' }, s, ENV, HOME) ?? '', /owner|closed/, `Grep ${s}`)
    }
  })
  test('the file rules and the sandbox deny owner.key, with the sandbox on and off', () => {
    for (const w of [protectConfig(`${dir}/env`, code, HOME), protectConfig(`${dir}/env`, code, HOME, true), protectConfig(`${dir}/env`, code, HOME, 'kagelet')]) {
      assert.ok(w.permissions.deny.includes(`Read(/${real}/owner.key)`))
      assert.ok(w.permissions.deny.includes(`Edit(/${real}/owner.key)`))
    }
    for (const w of [protectConfig(`${dir}/env`, code, HOME, true), protectConfig(`${dir}/env`, code, HOME, 'kagelet')]) {
      assert.ok(w.sandbox!.filesystem.denyRead.includes(`${real}/owner.key*`))
      assert.ok(w.sandbox!.filesystem.denyWrite.includes(`${real}/owner.key*`))
    }
  })
})

describe("a session's shell cannot run a kage command that acts as the owner", () => {
  const g = { ownerMemory: '/home/o/.claude/projects/-home-o/memory', envFile: '/home/o/.config/kage/env' }
  const no = (command: string) => assert.match(toolRefusal('Bash', { command }, 'owner', g) ?? '', /owner's own terminal/, command)
  const yes = (command: string) => assert.equal(toolRefusal('Bash', { command }, 'owner', g), undefined, command)
  test('tell, relay, stop, attach, call, reload, restart, add, remove, trust revoke are refused, plain, with env -u and with an empty KAGE_CLAUDE', () => {
    for (const sub of ['tell dm "deploy prod"', 'relay allow C1:5.5', 'stop C1:5.5', 'attach C1:5.5', 'call', 'reload', 'restart', 'add UTEST1', 'remove UTEST1', 'trust revoke T1']) {
      no(`kage ${sub}`)
      no(`env -u KAGE_CLAUDE kage ${sub}`)
      no(`KAGE_CLAUDE= kage ${sub}`)
    }
    no('unset KAGE_CLAUDE; kage tell dm hi')
    for (const sub of ['thread send dm hi', 'thread attach C1:5.5', 'thread stop C1:5.5', 'kagelet stop triage', 'kagelet start triage', 'kagelet add triage', 'config reload', 'person add UTEST1', 'person rm UTEST1', 'post dm hi', 'away on', 'away off', 'schedule add --cron x --prompt y', 'schedule rm ab12', 'schedule pause ab12', 'schedule resume ab12', 'schedule tune ab12 --cron x']) {
      no(`kage ${sub}`)
      no(`KAGE_CLAUDE= kage ${sub}`)
      no(`~/kage/setup.sh ${sub}`)
    }
    no('cd /tmp && ~/kage/setup.sh tell dm hi')
    no("'kage' tell dm hi")
    no('node ~/kage/src/cli/tell.ts dm hi')
    no('sh -c "kage relay allow C1:5.5"')
    no('node ~/kage/src/cli/trust.ts revoke T1')
  })
  test('the read commands and words that only mention them still run', () => {
    for (const c of ['kage status', 'kage list', 'kage person list', 'kage kagelet list', 'kage kagelet logs triage', 'kage thread follow', 'kage waiting list', 'kage schedule list', 'kage schedule view ab12', 'kage schedules', 'kage logs 200', 'kage stats 7', 'kage cost', 'kage doctor', 'kage help tell', 'kage trust list', 'node ~/kage/src/cli/trust.ts list', 'git commit -m "kage tell is owner only"', 'grep -rn "kage stop" docs']) yes(c)
  })
})
