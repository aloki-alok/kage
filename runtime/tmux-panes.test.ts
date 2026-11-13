import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmuxPanes } from './tmux-panes.ts'

// Under launchd or systemd the hub runs with no tmux session, and often with no tmux at all.
test('with no tmux session for this name, no pane is running and nothing throws', () => {
  const t = tmuxPanes({ name: `kagetest-none-${process.pid}`, envFile: '/nowhere/env', claude: 'claude', idOf: () => 'id1', placeOf: k => k, onStart: () => {} })
  assert.deepEqual(t.running(), new Set())
  assert.equal(t.runner.busy('C1:1.1'), false)
})
