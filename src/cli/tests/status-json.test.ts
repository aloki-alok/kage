import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import type { ToSession } from '../../runtime/protocol.ts'
import { listenForSessions } from '../../runtime/session-link.ts'
import { openStore } from '../../runtime/store.ts'

const KEY = 'd4'.repeat(32)
const envOf = (dir: string) => ({ ...process.env, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '', KAGE_SESSION: '', KAGE_THREAD: '' })
const task = (content: string): Task => ({ type: 'task', content, fromOwner: true, meta: { channel: 'C0TEST1', thread_ts: '5.5', place: '#general', permalink: '' }, origin: { channel: 'C0TEST1', ts: '5.5' } })

test('kage status --json with Kage down exits 3 and prints nothing on stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-status-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  const r = spawnSync('bash', [new URL('../../../setup.sh', import.meta.url).pathname, 'status', '--json'], { encoding: 'utf8', env: envOf(dir) })
  assert.equal(r.status, 3, r.stderr)
  assert.equal(r.stdout, '')
})

test('kage status --json gives the summary, each connector, each thread and each kagelet as data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-status-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  writeFileSync(join(dir, 'owner.key'), KEY, { mode: 0o600 })
  openStore(join(dir, 'kage.db'))
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => true }, { max: 4, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' })
  d.task('C0TEST1:5.5', task('work'), 0)
  d.connect('C0TEST1:5.5', () => {})
  const hub = listenForSessions(join(dir, 'router.sock'), d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    health: () => ['email     on'], healthRows: () => [{ name: 'email', on: true, bridgeDown: false, lastHeardAt: null, failedLastHour: 0, lastFailure: null }],
  })
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))
  const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>(res => {
    const c = spawn(process.execPath, [new URL('../status.ts', import.meta.url).pathname, '--json'], { env: envOf(dir) })
    let stdout = '', stderr = ''
    c.stdout.on('data', b => { stdout += b })
    c.stderr.on('data', b => { stderr += b })
    c.on('close', status => res({ status, stdout, stderr }))
  })
  assert.equal(out.status, 0, out.stderr)
  const s = JSON.parse(out.stdout) as Record<string, unknown>
  assert.deepEqual(Object.keys(s).sort(), ['connectors', 'dailyAverage', 'kagelets', 'paused', 'says', 'schedules', 'spentToday', 'starts', 'threads', 'turnsToday', 'upSec', 'version', 'warn'])
  assert.deepEqual(s.connectors, [{ name: 'email', on: true, bridgeDown: false, lastHeardAt: null, failedLastHour: 0, lastFailure: null }])
  assert.deepEqual((s.threads as { key: string }[]).map(x => x.key), ['C0TEST1:5.5'])
})
