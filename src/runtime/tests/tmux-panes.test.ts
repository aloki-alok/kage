import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProject, paneArgs, tmuxPanes } from '../tmux-panes.ts'
import { protectConfig } from '../path-guards.ts'
import { Dispatcher } from '../../core/sessions.ts'
import { taskAsOwner } from '../../core/gate.ts'
import { paneHello } from '../owner-key.ts'
import type { ToSession } from '../protocol.ts'
import { listenForSessions } from '../session-link.ts'

test('with no tmux session for this name, no pane is running and nothing throws', () => {
  const t = tmuxPanes({ name: `kagetest-none-${process.pid}`, envFile: '/nowhere/env', claude: 'claude', settings: () => ({}), ownerKey: 'd4'.repeat(32), idOf: () => 'id1', placeOf: k => k, onStart: () => {} })
  assert.deepEqual(t.running(), new Set())
  assert.equal(t.runner.busy('C1:1.1'), false)
})

test('a pane launches claude with the sandbox settings, and the SSM token only when one was issued', () => {
  const settings = { autoMemoryDirectory: '/m', ...protectConfig('/c/kage/env', '/code', '/home/o', true) }
  const a = paneArgs({ key: 'C1:1.1', id: 'id1', project: '/p', cwd: '/w', envFile: '/c/kage/env', claude: 'claude --x', settings, linkToken: 'link-C1' })
  const run = a.at(-1)!
  assert.equal(run.match(/--settings/g)?.length, 2, 'one per branch of the resume/new loop')
  assert.ok(run.includes('--settings "$KAGE_PANE_SETTINGS"'))
  const env = Object.fromEntries(a.flatMap((x, i) => a[i - 1] === '-e' ? [x.split(/=(.*)/s).slice(0, 2) as [string, string]] : []))
  const sent = JSON.parse(env.KAGE_PANE_SETTINGS!)
  assert.equal(sent.sandbox.enabled, true)
  assert.equal(sent.sandbox.failIfUnavailable, true)
  assert.ok(sent.permissions.deny.includes('Read(//c/kage/secrets.json)'))
  assert.equal(sent.autoMemoryDirectory, '/m')
  assert.equal(env.KAGE_SSM_TOKEN, undefined)
  assert.equal(env.KAGE_LINK_TOKEN, 'link-C1')
  assert.equal(env.PATH, undefined)
  const b = paneArgs({ key: 'C1:1.1', id: 'id1', project: '/p', cwd: '/w', envFile: '/c/kage/env', claude: 'claude', settings, linkToken: 'link-C1', ssm: { token: 'tok', sock: '/c/kage/ssm.sock', shim: '/code/cli/ssm-plugin-shim' } })
  assert.ok(b.includes('KAGE_SSM_TOKEN=tok') && b.includes('KAGE_SSM_SOCK=/c/kage/ssm.sock'))
  assert.ok(b.includes(`PATH=/code/cli/ssm-plugin-shim:${process.env.PATH}`))
})

test('a started pane is tagged with its session id, reads as busy while claude works, and its transcript gives the last activity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kage-panes-')), oldHome = process.env.HOME
  process.env.HOME = home
  const name = `kagetest-panes-${process.pid}`
  const ids: Record<string, string> = { a: 'ida', b: 'idb' }
  let starts = 0
  const t = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'echo "… (3s · thinking)"; sleep 60' sh`, settings: () => ({}), ownerKey: 'd4'.repeat(32), idOf: k => ids[k], placeOf: k => `#${k}`, onStart: () => { starts++ } })
  try {
    t.runner.start('a', 'ida')
    t.runner.start('b', 'idb')
    assert.equal(starts, 2)
    assert.deepEqual([...t.running()].sort(), ['ida', 'idb'])
    assert.deepEqual(execFileSync('tmux', ['list-windows', '-t', `=${name}`, '-F', '#{window_name}'], { encoding: 'utf8' }).trim().split('\n'), ['threads'])
    let busy: unknown = false
    for (let i = 0; i < 50 && busy !== true; i++) { await new Promise(r => setTimeout(r, 100)); busy = t.runner.busy('a') }
    assert.equal(busy, true)
    const project = claudeProject(process.cwd())
    assert.equal(t.hasTranscript('ida'), false)
    assert.equal(t.runner.lastActivity('a'), 0)
    mkdirSync(join(project, 'ida', 'subagents'), { recursive: true })
    writeFileSync(join(project, 'ida.jsonl'), '')
    writeFileSync(join(project, 'ida', 'subagents', 's.jsonl'), '')
    utimesSync(join(project, 'ida.jsonl'), 1000, 1000)
    utimesSync(join(project, 'ida', 'subagents', 's.jsonl'), 2000, 2000)
    assert.equal(t.hasTranscript('ida'), true)
    assert.equal(t.runner.lastActivity('a'), 2_000_000)
    t.runner.stop('a')
    assert.deepEqual([...t.running()], ['idb'])
    assert.equal(t.runner.busy('a'), false)
  } finally {
    process.env.HOME = oldHome
    try { execFileSync('tmux', ['kill-session', '-t', `=${name}`]) } catch {}
  }
})

function isolatedTmux(t: { after: (f: () => void) => void }) {
  const was = { tmpdir: process.env.TMUX_TMPDIR, tmux: process.env.TMUX, pane: process.env.TMUX_PANE }
  process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), 'kage-tmux-'))
  delete process.env.TMUX
  delete process.env.TMUX_PANE
  t.after(() => {
    try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }) } catch {}
    for (const [k, v] of [['TMUX_TMPDIR', was.tmpdir], ['TMUX', was.tmux], ['TMUX_PANE', was.pane]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v
  })
}
const windows = (name: string) => execFileSync('tmux', ['list-windows', '-t', `=${name}`, '-F', '#{window_name}'], { encoding: 'utf8' }).trim().split('\n')

test("a new owner key closes only Kage's own tagged panes, on any runner: a window of the person's in a session named kage stays", t => {
  isolatedTmux(t)
  const name = 'kage', ids: Record<string, string> = { a: 'ida', b: 'idb' }
  execFileSync('tmux', ['new-session', '-d', '-s', name, '-n', 'mine', 'sleep 60'])
  const t2 = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'sleep 60' sh`, settings: () => ({}), ownerKey: 'd4'.repeat(32), idOf: k => ids[k], placeOf: k => `#${k}`, onStart: () => {} })
  t2.runner.start('a', 'ida')
  t2.runner.start('b', 'idb')
  assert.deepEqual([...t2.adoptable(false)].sort(), ['ida', 'idb'])
  assert.deepEqual([...t2.running()].sort(), ['ida', 'idb'])
  assert.deepEqual([...t2.adoptable(true)], [], 'the hub adopted panes that can never link')
  assert.deepEqual([...t2.running()], [])
  assert.deepEqual([...t2.adoptable(true)], [])
  assert.ok(windows(name).includes('mine'), 'the person\'s own window was closed')
})

test('a new owner key never closes the pane the hub itself runs in', t => {
  isolatedTmux(t)
  const name = 'kage', ids: Record<string, string> = { a: 'ida' }
  const t2 = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'sleep 60' sh`, settings: () => ({}), ownerKey: 'd4'.repeat(32), idOf: k => ids[k], placeOf: k => `#${k}`, onStart: () => {} })
  t2.runner.start('a', 'ida')
  process.env.TMUX_PANE = execFileSync('tmux', ['list-panes', '-s', '-t', `=${name}`, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim().split('\n')[0]
  assert.deepEqual([...t2.adoptable(true)], [])
  assert.deepEqual([...t2.running()], ['ida'])
})

test('a pane that dies between the list and the kill counts as closed, and the hub starts', t => {
  isolatedTmux(t)
  const name = 'kage', ids: Record<string, string> = { a: 'ida' }
  const real = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
  const shim = mkdtempSync(join(tmpdir(), 'kage-tmux-shim-')), path = process.env.PATH
  writeFileSync(join(shim, 'tmux'), `#!/bin/sh\nout=$("${real}" "$@") || exit $?\nprintf '%s\\n' "$out"\ncase "$*" in *list-panes*@kage*) echo 'idgone %999' ;; esac\n`, { mode: 0o755 })
  process.env.PATH = `${shim}:${path}`
  t.after(() => { process.env.PATH = path })
  const t2 = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'sleep 60' sh`, settings: () => ({}), ownerKey: 'd4'.repeat(32), idOf: k => ids[k], placeOf: k => `#${k}`, onStart: () => {} })
  t2.runner.start('a', 'ida')
  assert.deepEqual([...t2.running()].sort(), ['ida', 'idgone'])
  assert.deepEqual([...t2.adoptable(true)], [])
  assert.deepEqual([...t2.running()], [])
})

test("a pane's plugin says hello with the token its pane was started with, and the hub with the same owner key takes it", async t => {
  const KEY = 'c3'.repeat(32), dir = mkdtempSync(join(tmpdir(), 'kage-link-pane-')), name = `kagetest-link-${process.pid}`
  const t2 = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'printenv KAGE_LINK_TOKEN > ${dir}/token; sleep 60' sh`, settings: () => ({}), ownerKey: KEY, idOf: () => 'idA', placeOf: k => k, onStart: () => {} })
  t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', `=${name}`]) } catch {} })
  t2.runner.start('C1:5.5', 'idA')
  for (let i = 0; i < 100 && !existsSync(`${dir}/token`); i++) await new Promise(r => setTimeout(r, 50))
  const paneEnv = { KAGE_LINK_TOKEN: readFileSync(`${dir}/token`, 'utf8').trim() }

  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'idA' })
  d.task('C1:5.5', taskAsOwner({ content: 'for the pane', meta: { channel: 'C1', thread_ts: '5.5', place: '#g', permalink: '' }, origin: { channel: 'C1', ts: '5.5' } }), 0)
  const server = listenForSessions(join(dir, 's.sock'), d, { ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  t.after(() => server.close())
  await new Promise(r => server.once('listening', r))
  const c = connect(join(dir, 's.sock'))
  t.after(() => c.destroy())
  let got = ''
  c.on('data', b => { got += b })
  c.write(JSON.stringify(paneHello('C1:5.5', paneEnv)) + '\n')
  for (let i = 0; i < 100 && !got.includes('\n'); i++) await new Promise(r => setTimeout(r, 10))
  assert.match(got, /for the pane/)
})
