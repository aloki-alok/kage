import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configRefusal, protectConfig, ownerMemoryRefusal, privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../guards.ts'


describe('private sources on a teammate task', () => {
  const MAIL = 'mcp__claude_ai_Gmail__search_threads'
  test('the owner may read mail', () => assert.equal(privateToolRefusal(MAIL, 'owner'), undefined))
  test('a teammate may not read mail, drive, calendar or meeting notes', () => {
    for (const t of [MAIL, 'mcp__claude_ai_Google_Drive__read', 'mcp__claude_ai_Google_Calendar__list', 'mcp__granola__query_granola_meetings', 'mcp__plugin_product-management_fireflies__get'])
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/)
  })
  test('an unknown sender is refused', () => assert.ok(privateToolRefusal(MAIL, undefined)))
  test("only the owner's task reaches the owner's browser", () => {
    for (const t of ['mcp__kage__browser_tabs', 'mcp__kage__browser_read', 'mcp__plugin_kage_kage__browser_screenshot']) {
      assert.equal(privateToolRefusal(t, 'owner'), undefined, t)
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/, t)
    }
  })
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
      assert.match(ownerMemoryRefusal('Write', { file_path: '~/.claude/projects/-home-o/memory/feedback_x.md' }, MEM, '/home/o') ?? '', /people notes/)
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
      ok('Write', '/home/o/.config/kage/memory/feedback_x.md'); ok('Read', `${MEM}/feedback_x.md`); ok('Write', '/tmp/x.md')
    })
  })
  test('other tools are fine for a teammate', () => {
    for (const t of ['WebSearch', 'WebFetch', 'Bash', 'Read', 'mcp__kage__reply', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.equal(privateToolRefusal(t, 'teammate'), undefined)
  })
})

describe('tools on a voice call', () => {
  test('only the reply tool is allowed: a web request could carry the owner context out in a URL', () => {
    // ToolSearch only loads a deferred tool's schema (the reply tool is often deferred); what it loads still passes this guard.
    for (const t of ['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'ToolSearch']) assert.equal(voiceToolRefusal(t, 'voice'), undefined, t)
  })
  test('shell, files, posting, scheduling and other MCP tools are refused', () => {
    for (const t of ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Agent', 'mcp__kage__edit_message', 'mcp__kage__delete_message', 'mcp__kage__schedule', 'mcp__kage__log_prod_write', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.match(voiceToolRefusal(t, 'voice') ?? '', /voice call/, t)
  })
  test('other senders are not limited here', () => {
    for (const s of ['owner', 'teammate', undefined]) assert.equal(voiceToolRefusal('Bash', s), undefined)
  })
})

describe("Slack posts go through Kage's own tools", () => {
  test('the Slack connector may not send or schedule a message', () => {
    for (const t of ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_schedule_message', 'mcp__plugin_design_slack__slack_send_message', 'mcp__slack__slack_post_message', 'mcp__slack__slack_reply_to_thread', 'mcp__slack-community__conversations_add_message', 'mcp__slack__chat_postMessage']) assert.match(slackSendRefusal(t)!, /reply|message_people/)
  })
  test('reading Slack, drafts and canvases still work, and so do Kage tools', () => {
    for (const t of ['mcp__claude_ai_Slack__slack_read_thread', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_create_canvas', 'mcp__kage__reply', 'mcp__kage__message_people']) assert.equal(slackSendRefusal(t), undefined)
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
      // Relative to the home folder a session starts in, and out of an open subfolder.
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
    }
    no('Grep', { pattern: 'xox', path: '/home/o/.config/kage' }, 'owner')
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
    // A thread's own files folder sits inside the config folder: reports and send_file use it.
    yes('Bash', { command: 'python3 run.py /home/o/.config/kage/files/C1_5.5' }, 'teammate')
    yes('Read', { file_path: '~/.config/kage/files/C1_5.5/out.csv' }, 'teammate')
    no('Bash', { command: 'cp ~/.config/kage/files/C1_5.5/x ~/.config/kage/env' }, 'teammate')
    yes('Bash', { command: 'ls ~/.config/kage/files' }, 'teammate')
    // Kage's own memory sits there too, and it saves lessons on any task.
    yes('Read', { file_path: '/home/o/.config/kage/memory/MEMORY.md' }, 'teammate')
    yes('Write', { file_path: '~/.config/kage/memory/x.md', content: 'the env file is ~/.config/kage/env' }, 'teammate')
    // A neighbour folder is not it.
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

describe('protectConfig: what the sandbox and the file rules close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-protect-'))
  const code = mkdtempSync(join(tmpdir(), 'kage-code-'))
  for (const f of ['config.json', 'secrets.json', 'afk.json', 'hub.log']) writeFileSync(join(dir, f), '')
  for (const d of ['files', 'memory', 'sender']) mkdirSync(join(dir, d))
  const w = protectConfig(`${dir}/env`, code, '/home/o')
  const real = (p: string) => realpathSync(p)
  test('a shell may not write anything in the config folder but files/ and memory/, whether or not it exists yet', () => {
    const deny = w.sandbox.filesystem.denyWrite
    for (const n of ['session.env', 'kagelets', 'specialists', 'config.json*', 'secrets.json*', 'env*', 'afk.json', 'hub.log', 'sender']) assert.ok(deny.includes(`${real(dir)}/${n}`), n)
    for (const n of ['files', 'memory']) assert.ok(!deny.some(d => d === `${real(dir)}/${n}` || d === real(dir)), n)
  })
  test('no session reads session.env or the waha key file, though only secrets.json and env* were named before', () => {
    const read = w.sandbox.filesystem.denyRead
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
    const deny = w.sandbox.filesystem.denyWrite
    for (const n of ['crons-import.json*', 'waha', 'threads.json*', 'afk.json*', 'github-threads.json*', 'mail-threads.json*', 'kage.db*', 'hub.lock', 'router.sock']) assert.ok(deny.includes(`${real(dir)}/${n}`), n)
  })
  test('every name the code builds under the config folder with ${DIR}/, ${CONF}/ or ${o.dir}/ is on that list or is files/ or memory/', () => {
    const root = new URL('../../', import.meta.url).pathname
    const names = w.sandbox.filesystem.denyWrite.map(d => d.split('/').pop()!)
    const covered = (n: string) => names.some(d => d === n || (d.endsWith('*') && n.startsWith(d.slice(0, -1))))
    const seen = new Set<string>()
    for (const f of execFileSync('git', ['ls-files', '*.ts', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !f.includes('tests/'))) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/\$\{(?:DIR|CONF|o\.dir)\}\/([A-Za-z0-9_.*-]+)/g)) seen.add(m[1]!.replace(/\.$/, ''))
    }
    // Names under the code folder, or kept open on purpose.
    const open = new Set(['files', 'memory', 'server.ts', 'node_modules', 'package-lock.json', 'browser-pair.sh', 'version', 'status', 'standin'])
    const missing = [...seen].filter(n => !covered(n) && !open.has(n))
    assert.deepEqual(missing, [], 'add these to CONFIG_NAMES in core/guards.ts, or to the open list here if a session needs to write them')
  })
  test('the hub code folder and the files the OS reads at login are closed to writes too', () => {
    const deny = w.sandbox.filesystem.denyWrite
    assert.ok(deny.includes(real(code)))
    assert.ok(deny.includes('/home/o/Library/LaunchAgents') && deny.includes('/home/o/.config/systemd'))
  })
  test('the file rules use Edit, which covers Write, and the sandbox must start', () => {
    assert.ok(w.permissions.deny.every(r => !r.startsWith('Write(')))
    assert.ok(w.permissions.deny.includes(`Edit(/${real(dir)}/config.json)`))
    assert.equal(w.sandbox.failIfUnavailable, true)
  })
})
