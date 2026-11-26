import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { ToSession } from '../../runtime/protocol.ts'
import { openLedgers } from '../../runtime/ledger.ts'
import { listenForSessions } from '../../runtime/session-link.ts'
import { openStore } from '../../runtime/store.ts'

const KEY = 'f6'.repeat(32)
const SETUP = new URL('../../../setup.sh', import.meta.url).pathname
type Run = { status: number | null; stdout: string; stderr: string }

function world(t: { after: (f: () => void) => void }, answer: (m: Record<string, unknown>) => { text: string } | { refused: string } = () => ({ text: 'Kage schedule ab12cd34 set.' })) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-sched-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  writeFileSync(join(dir, 'owner.key'), KEY, { mode: 0o600 })
  const store = openStore(join(dir, 'kage.db'))
  store.saveSessions({ 'C0TEST1:5.5': 'sess-a' })
  openLedgers(dir).close()
  const asked: Record<string, unknown>[] = []
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'x' })
  const hub = listenForSessions(join(dir, 'router.sock'), d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    jobs: m => { const { ownerKey: _, type: _t, ...rest } = m as Record<string, unknown>; asked.push(rest); return answer(rest) },
  })
  t.after(() => hub.close())
  return {
    dir, store, asked, listening: () => new Promise(r => hub.listening ? r(undefined) : hub.once('listening', r)),
    kage: (args: string[], input = '') => new Promise<Run>(res => {
      const c = spawn('bash', [SETUP, 'schedule', ...args], { env: { ...process.env, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '' } })
      let stdout = '', stderr = ''
      c.stdout.on('data', b => { stdout += b })
      c.stderr.on('data', b => { stderr += b })
      c.on('close', status => res({ status, stdout, stderr }))
      c.stdin.end(input)
    }),
  }
}

test('kage schedule add sends the job to the hub: a clock job in a thread, a probe, a channel watch, a webhook, and the DM by default', async t => {
  const w = world(t)
  await w.listening()
  const clock = await w.kage(['add', '--thread', 'C0TEST1:5.5', '--cron', '0 9 * * 1-5', '--prompt', 'post the standup'])
  assert.equal(clock.status, 0, clock.stderr)
  assert.match(clock.stdout, /ab12cd34 set/)
  await w.kage(['add', '--cron', '*/5 * * * *', '--probe', 'gh pr list', '--ignore', '^#', '--ignore', 'ago$', '--reads', 'notes.md', '--once', '--prompt', '-'], 'say what changed\n')
  await w.kage(['add', '--channel', 'C0TEST2', '--match', 'deploy', '--no-bots', '--prompt', 'check the deploy', '--model', 'haiku'])
  await w.kage(['add', '--hook', '--prompt', 'triage the alert', '--needs', 'mcp__linear__create_issue'])
  assert.deepEqual(w.asked, [
    { action: 'add', key: 'C0TEST1:5.5', spec: { cron: '0 9 * * 1-5', prompt: 'post the standup' } },
    { action: 'add', key: 'dm', spec: { cron: '*/5 * * * *', prompt: 'say what changed', recurring: false, probe: { command: 'gh pr list', ignore: ['^#', 'ago$'], reads: ['notes.md'] } } },
    { action: 'add', key: 'dm', spec: { on_channel: { channel: 'C0TEST2', match: 'deploy', bots: false }, prompt: 'check the deploy', model: 'haiku' } },
    { action: 'add', key: 'dm', spec: { hook: true, prompt: 'triage the alert', needs: ['mcp__linear__create_issue'] } },
  ])
})

test('a refused job exits 1 with the reason, and a missing prompt or an unknown flag exits 2 before the hub hears it', async t => {
  const w = world(t, () => ({ refused: 'minute 61 is out of range' }))
  await w.listening()
  const no = await w.kage(['add', '--cron', '61 * * * *', '--prompt', 'x'])
  assert.equal(no.status, 1)
  assert.match(no.stderr, /minute 61 is out of range/)
  assert.equal((await w.kage(['add', '--cron', '0 9 * * *'])).status, 2)
  assert.equal((await w.kage(['add', '--cron', '0 9 * * *', '--prompt', 'x', '--every', '5'])).status, 2)
  assert.equal(w.asked.length, 1)
})

test('rm, pause, resume and tune name the job, and tune sends only what changes', async t => {
  const w = world(t, m => ({ text: `done ${String(m.action)}` }))
  await w.listening()
  for (const verb of ['rm', 'pause', 'resume']) assert.equal((await w.kage([verb, 'ab12cd34'])).status, 0)
  await w.kage(['tune', 'ab12cd34', '--cron', '*/10 * * * *', '--ignore', 'ago$'])
  assert.equal((await w.kage(['tune', 'ab12cd34'])).status, 2)
  assert.equal((await w.kage(['rm'])).status, 2)
  assert.deepEqual(w.asked, [
    { action: 'rm', id: 'ab12cd34' }, { action: 'pause', id: 'ab12cd34' }, { action: 'resume', id: 'ab12cd34' },
    { action: 'tune', id: 'ab12cd34', change: { cron: '*/10 * * * *', ignore: ['ago$'] } },
  ])
})

test('kage schedule list shows a paused job as paused, and view shows one job with its last runs', async t => {
  const w = world(t)
  w.store.seen('C0TEST1:5.5', { connector: 'slack', chat: 'C0TEST1', thread: '5.5', kind: 'channel' } as never, '#general', 0)
  w.store.addSchedule({ id: 'aa11bb22', key: 'C0TEST1:5.5', cron: '0 9 * * *', prompt: 'post the standup', recurring: true, fromOwner: true, created: 1, lastFired: 0 })
  w.store.save('paused-jobs', { cc33dd44: { job: { id: 'cc33dd44', key: 'C0TEST1:5.5', cron: '*/5 * * * *', prompt: 'watch prs', recurring: true, fromOwner: true, created: 2, lastFired: 0 }, state: { fails: 0 }, at: 3 } })
  const l = openLedgers(w.dir)
  l.event({ kind: 'run.start', who: 'C0TEST1:5.5#side-job-aa11bb22', trace: 't1', detail: 'scheduled aa11bb22' })
  l.event({ kind: 'run.end', who: 'C0TEST1:5.5#side-job-aa11bb22', trace: 't1', detail: '$0.02, no report, ms=4000' })
  l.close()
  const rows = JSON.parse((await w.kage(['list', '--json'])).stdout) as { id: string; paused: boolean }[]
  assert.deepEqual(rows.map(r => [r.id, r.paused]), [['aa11bb22', false], ['cc33dd44', true]])
  assert.match((await w.kage(['list'])).stdout, /cc33dd44 .*paused/)
  const view = await w.kage(['view', 'aa11bb22'])
  assert.equal(view.status, 0, view.stderr)
  assert.match(view.stdout, /post the standup/)
  assert.match(view.stdout, /\$0\.02, no report, ms=4000/)
  assert.equal((await w.kage(['view', 'nope'])).status, 1)
})
