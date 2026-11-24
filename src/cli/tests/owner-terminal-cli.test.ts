import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { ToSession } from '../../runtime/protocol.ts'
import { listenForSessions } from '../../runtime/session-link.ts'
import { openStore } from '../../runtime/store.ts'
import { openLedgers } from '../../runtime/ledger.ts'

const KEY = 'c3'.repeat(32)
const SETUP = new URL('../../../setup.sh', import.meta.url).pathname
const envOf = (dir: string) => ({ ...process.env, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '' })
const run = (dir: string, ...args: string[]) => spawnSync('bash', [SETUP, ...args], { encoding: 'utf8', env: envOf(dir) })
const kage = (dir: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(res => {
  const child = spawn('bash', [SETUP, ...args], { env: envOf(dir) })
  let stdout = '', stderr = ''
  child.stdout.on('data', (b: Buffer) => { stdout += b })
  child.stderr.on('data', (b: Buffer) => { stderr += b })
  child.on('close', status => res({ status, stdout, stderr }))
})

function world(t: { after: (f: () => void) => void }, o: { away?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-owner-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  writeFileSync(join(dir, 'owner.key'), KEY, { mode: 0o600 })
  openStore(join(dir, 'kage.db')).saveSessions({ 'C0TEST1:5.5': 'id1', 'mail:abc': 'id2' })
  const said: unknown[] = [], away: unknown[] = []
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' })
  const hub = listenForSessions(join(dir, 'router.sock'), d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    say: async (text, at) => { said.push({ text, ...at }); return { ok: true as const, channel: at?.channel ?? 'DTEST', ts: '9.9' } },
    ...o.away !== false && { away: async (c: unknown) => { away.push(c); return (c as { kind: string }).kind === 'back' ? 'Back. Nobody needed you.' : 'AFK on until 18:30.' } },
  })
  t.after(() => hub.close())
  return { dir, said, away, listening: () => new Promise(r => hub.listening ? r(undefined) : hub.once('listening', r)) }
}

test('kage post posts as Kage in the DM or in a Slack thread Kage has, through the hub', async t => {
  const w = world(t)
  await w.listening()
  const dm = await kage(w.dir, 'post', 'dm', 'standup', 'in', '5')
  assert.equal(dm.status, 0, dm.stderr)
  const thread = await kage(w.dir, 'post', 'C0TEST1:5.5', 'done')
  assert.equal(thread.status, 0, thread.stderr)
  assert.deepEqual(w.said, [{ text: 'standup in 5' }, { text: 'done', channel: 'C0TEST1', thread_ts: '5.5' }])
})
test('kage post refuses a thread that is not in Slack, and bad usage exits 2', async t => {
  const w = world(t)
  await w.listening()
  const mail = await kage(w.dir, 'post', 'mail:abc', 'hi')
  assert.equal(mail.status, 1)
  assert.match(mail.stderr, /posts only in the DM with Kage or a Slack thread/)
  assert.equal((await kage(w.dir, 'post', 'dm')).status, 2)
  assert.deepEqual(w.said, [])
})
test('kage away on --until and off reach the hub, and a bad time is refused', async t => {
  const w = world(t)
  await w.listening()
  const on = await kage(w.dir, 'away', 'on', '--until', '18:30', 'at', 'the', 'dentist')
  assert.equal(on.status, 0, on.stderr)
  assert.match(on.stdout, /AFK on until 18:30/)
  const off = await kage(w.dir, 'away', 'off')
  assert.match(off.stdout, /Back\./)
  const bad = await kage(w.dir, 'away', 'on', '--until', '25:00')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /24-hour time/)
  assert.deepEqual(w.away, [{ kind: 'afk', note: 'at the dentist', at: { h: 18, m: 30 } }, { kind: 'back' }])
})
test('kage waiting list shows the open asks newest first, and --json gives the rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-waiting-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  openStore(join(dir, 'kage.db'))
  const l = openLedgers(dir)
  l.add('waiting', ['open', 'C0TEST1:1.1', 'https://x.test/a', 'Merge the PR?'])
  l.add('waiting', ['open', 'C0TEST1:2.2', 'https://x.test/b', 'Ship it?'])
  l.add('waiting', ['answered', 'C0TEST1:1.1', '', ''])
  l.close()
  const text = run(dir, 'waiting', 'list')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Ship it\?.*https:\/\/x\.test\/b/)
  assert.doesNotMatch(text.stdout, /Merge the PR/)
  const rows = JSON.parse(run(dir, 'waiting', 'list', '--json').stdout) as { thread: string }[]
  assert.deepEqual(rows.map(r => r.thread), ['C0TEST1:2.2'])
})
