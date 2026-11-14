import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paneArgs, tmuxPanes } from '../tmux-panes.ts'
import { protectConfig } from '../../core/guards.ts'

// Under launchd or systemd the hub runs with no tmux session, and often with no tmux at all.
test('with no tmux session for this name, no pane is running and nothing throws', () => {
  const t = tmuxPanes({ name: `kagetest-none-${process.pid}`, envFile: '/nowhere/env', claude: 'claude', settings: () => ({}), idOf: () => 'id1', placeOf: k => k, onStart: () => {} })
  assert.deepEqual(t.running(), new Set())
  assert.equal(t.runner.busy('C1:1.1'), false)
})

// A pane's claude gets the settings an SDK session gets (core/guards.ts protectConfig), so the config folder stays closed
// even when the pane's shell unsets KAGE_SESSION. One --settings flag: a second one would replace the first.
test('a pane launches claude with the sandbox settings, and the SSM token only when one was issued', () => {
  const settings = { autoMemoryDirectory: '/m', ...protectConfig('/c/kage/env', '/code', '/home/o') }
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
  const b = paneArgs({ key: 'C1:1.1', id: 'id1', project: '/p', cwd: '/w', envFile: '/c/kage/env', claude: 'claude', settings, ssm: { token: 'tok', sock: '/c/kage/ssm.sock' } })
  assert.ok(b.includes('KAGE_SSM_TOKEN=tok') && b.includes('KAGE_SSM_SOCK=/c/kage/ssm.sock'))
})
