import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProject, paneArgs, tmuxPanes } from '../tmux-panes.ts'
import { protectConfig } from '../path-guards.ts'

test('with no tmux session for this name, no pane is running and nothing throws', () => {
  const t = tmuxPanes({ name: `kagetest-none-${process.pid}`, envFile: '/nowhere/env', claude: 'claude', settings: () => ({}), idOf: () => 'id1', placeOf: k => k, onStart: () => {} })
  assert.deepEqual(t.running(), new Set())
  assert.equal(t.runner.busy('C1:1.1'), false)
})

test('a pane launches claude with the sandbox settings, and the SSM token only when one was issued', () => {
  const settings = { autoMemoryDirectory: '/m', ...protectConfig('/c/kage/env', '/code', '/home/o', true) }
  const a = paneArgs({ key: 'C1:1.1', id: 'id1', project: '/p', cwd: '/w', envFile: '/c/kage/env', claude: 'claude --x', settings })
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
  assert.equal(env.PATH, undefined)
  const b = paneArgs({ key: 'C1:1.1', id: 'id1', project: '/p', cwd: '/w', envFile: '/c/kage/env', claude: 'claude', settings, ssm: { token: 'tok', sock: '/c/kage/ssm.sock', shim: '/code/cli/ssm-plugin-shim' } })
  assert.ok(b.includes('KAGE_SSM_TOKEN=tok') && b.includes('KAGE_SSM_SOCK=/c/kage/ssm.sock'))
  assert.ok(b.includes(`PATH=/code/cli/ssm-plugin-shim:${process.env.PATH}`))
})

test('a started pane is tagged with its session id, reads as busy while claude works, and its transcript gives the last activity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kage-panes-')), oldHome = process.env.HOME
  process.env.HOME = home
  const name = `kagetest-panes-${process.pid}`
  const ids: Record<string, string> = { a: 'ida', b: 'idb' }
  let starts = 0
  const t = tmuxPanes({ name, envFile: '/nowhere/env', claude: `sh -c 'echo "… (3s · thinking)"; sleep 60' sh`, settings: () => ({}), idOf: k => ids[k], placeOf: k => `#${k}`, onStart: () => { starts++ } })
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
