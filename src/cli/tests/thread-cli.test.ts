import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionKey } from '../../core/conversations.ts'
import { Dispatcher } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import type { ToSession } from '../../runtime/protocol.ts'
import { openLedgers } from '../../runtime/ledger.ts'
import { listenForSessions } from '../../runtime/session-link.ts'
import { openStore } from '../../runtime/store.ts'

const KEY = 'e5'.repeat(32)
const SETUP = new URL('../../../setup.sh', import.meta.url).pathname
type Run = { status: number | null; stdout: string; stderr: string }
const task = (content: string): Task => ({ type: 'task', content, fromOwner: true, meta: { channel: 'C0TEST1', thread_ts: '5.5', place: '#general', permalink: '' }, origin: { channel: 'C0TEST1', ts: '5.5' } })
const line = (o: object) => JSON.stringify(o) + '\n'
const replyLine = (text: string, waiting?: string) => line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name: 'mcp__kage__reply', input: { channel: 'C0TEST1', thread_ts: '5.5', text, ...waiting && { waiting, waiting_on: 'owner' } } }] } })

type Told = (key: string, text: string, w: World) => { ok: true } | { refused: string }
type World = ReturnType<typeof world>
function world(t: { after: (f: () => void) => void }, told: Told = () => ({ ok: true })) {
  const home = mkdtempSync(join(tmpdir(), 'kage-thread-home-'))
  const dir = join(home, '.config', 'kage')
  const cwd = mkdtempSync(join(tmpdir(), 'kage-thread-cwd-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, harness: { cwd } }))
  writeFileSync(join(dir, 'owner.key'), KEY, { mode: 0o600 })
  const project = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const store = openStore(join(dir, 'kage.db'))
  store.saveSessions({ 'C0TEST1:5.5': 'sess-a', 'C0TEST1:7.7': 'sess-b' })
  store.seen('C0TEST1:5.5', parseSessionKey('C0TEST1:5.5')!.conversation, '#general', 2_000)
  store.seen('C0TEST1:7.7', parseSessionKey('C0TEST1:7.7')!.conversation, '#general-ops', 1_000)
  writeFileSync(join(project, 'sess-a.jsonl'), replyLine('an old reply'))
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => true }, { max: 4, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'sess-a' })
  d.task('C0TEST1:5.5', task('work'), 0)
  d.connect('C0TEST1:5.5', () => {})
  const w = {
    dir, home, project, told: [] as string[],
    transcript: (s: string) => appendFileSync(join(project, 'sess-a.jsonl'), s),
    ended: () => { const l = openLedgers(dir); l.event({ kind: 'run.end', who: 'C0TEST1:5.5', trace: 't1', detail: 'ok', transcript: join(project, 'sess-a.jsonl') }); l.close() },
    listening: () => new Promise(r => hub.listening ? r(undefined) : hub.once('listening', r)),
    kage: (args: string[], input?: string) => new Promise<Run>(res => {
      const c = spawn('bash', [SETUP, ...args], { env: { ...process.env, HOME: home, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '' } })
      let stdout = '', stderr = ''
      c.stdout.on('data', b => { stdout += b })
      c.stderr.on('data', b => { stderr += b })
      c.on('close', status => res({ status, stdout, stderr }))
      c.stdin.end(input ?? '')
    }),
  }
  const hub = listenForSessions(join(dir, 'router.sock'), d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    tell: (key, text) => { w.told.push(`${key} ${text}`); return told(key, text, w) },
  })
  t.after(() => { hub.close(); store.close?.() })
  return w
}

test('kage thread list shows each thread newest first, with its place, key, state and last activity, and --json', async t => {
  const w = world(t)
  await w.listening()
  const text = await w.kage(['thread', 'list'])
  assert.equal(text.status, 0, text.stderr)
  const lines = text.stdout.trim().split('\n')
  assert.match(lines[0]!, /#general\s+C0TEST1:5\.5\s+busy/)
  assert.match(lines[1]!, /#general-ops\s+C0TEST1:7\.7\s+idle/)
  const rows = JSON.parse((await w.kage(['thread', 'list', '--json'])).stdout) as { key: string; place: string; state: string; lastSeen: string }[]
  assert.deepEqual(rows.map(r => [r.key, r.place, r.state]), [['C0TEST1:5.5', '#general', 'busy'], ['C0TEST1:7.7', '#general-ops', 'idle']])
  assert.equal(rows[0]!.lastSeen, new Date(2_000).toISOString())
})
