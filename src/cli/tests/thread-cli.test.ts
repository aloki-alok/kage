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
const taskLine = (text: string) => line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: `<channel source="kage">\nFrom the owner, typed in the terminal: ${text}\n</channel>` } })
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
  openLedgers(dir).close()
  store.saveSessions({ 'C0TEST1:5.5': 'sess-a', 'C0TEST1:7.7': 'sess-b', 'C0TEST1:9.9#side-kagelet-deploys': 'sess-a' })
  store.seen('C0TEST1:5.5', parseSessionKey('C0TEST1:5.5')!.conversation, '#general', 2_000)
  store.seen('C0TEST1:7.7', parseSessionKey('C0TEST1:7.7')!.conversation, '#general-ops', 1_000)
  writeFileSync(join(project, 'sess-a.jsonl'), replyLine('an old reply'))
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => true }, { max: 4, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'sess-a' })
  d.task('C0TEST1:5.5', task('work'), 0)
  d.connect('C0TEST1:5.5', () => {})
  const w = {
    dir, home, project, told: [] as string[],
    transcript: (s: string) => appendFileSync(join(project, 'sess-a.jsonl'), s),
    ended: (who = 'C0TEST1:5.5') => { const l = openLedgers(dir); l.event({ kind: 'run.end', who, trace: 't1', detail: 'ok', transcript: join(project, 'sess-a.jsonl') }); l.close() },
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
  assert.deepEqual(rows.map(r => [r.key, r.place, r.state]), [['C0TEST1:5.5', '#general', 'busy'], ['C0TEST1:7.7', '#general-ops', 'idle'], ['C0TEST1:9.9#side-kagelet-deploys', 'C0TEST1:9.9#side-kagelet-deploys', 'idle']])
  assert.equal(rows[0]!.lastSeen, new Date(2_000).toISOString())
})

const later = (ms: number, f: () => void) => { setTimeout(f, ms) }

test('kage thread send --wait prints the replies of the turn it starts and exits 0 when the turn ends', async t => {
  const w = world(t, (_k, _t, w) => {
    later(200, () => { w.transcript(replyLine('Still on the last task.')); w.ended() })
    later(800, () => { w.transcript(taskLine('deploy it')); w.transcript(replyLine('Deployed to staging.')); w.transcript(replyLine('All 12 checks pass.')) })
    later(1200, () => w.ended())
    return { ok: true }
  })
  await w.listening()
  const r = await w.kage(['thread', 'send', '--wait', 'C0TEST1:5.5', 'deploy', 'it'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'Deployed to staging.\nAll 12 checks pass.\n')
  assert.deepEqual(w.told, ['C0TEST1:5.5 deploy it'])
})
test('--wait on a kagelet lane ends on the run.end logged under the kagelet name', async t => {
  const w = world(t, (_k, _t, w) => { later(200, () => { w.transcript(taskLine('check')); w.transcript(replyLine('Deploys look fine.')) }); later(500, () => w.ended('deploys')); return { ok: true } })
  await w.listening()
  const r = await w.kage(['thread', 'send', '--wait', '--timeout', '10s', 'C0TEST1:9.9#side-kagelet-deploys', 'check'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'Deploys look fine.\n')
})
test('--wait returns as soon as the thread asks the owner something, and names the question', async t => {
  const w = world(t, (_k, _t, w) => { later(300, () => { w.transcript(taskLine('go')); w.transcript(replyLine('Staging is green. Ship to prod?', 'Ship to prod?')) }); return { ok: true } })
  await w.listening()
  const r = await w.kage(['thread', 'send', '--wait', '--timeout', '20s', 'C0TEST1:5.5', 'go'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'Staging is green. Ship to prod?\n')
  assert.match(r.stderr, /waits on your answer: Ship to prod\?/)
})
test('--wait gives up after --timeout with exit 1 and what came so far', async t => {
  const w = world(t, (_k, _t, w) => { later(200, () => { w.transcript(taskLine('build')); w.transcript(replyLine('Starting the build.')) }); return { ok: true } })
  await w.listening()
  const r = await w.kage(['thread', 'send', '--wait', '--timeout', '2s', 'C0TEST1:5.5', 'build'])
  assert.equal(r.status, 1)
  assert.equal(r.stdout, 'Starting the build.\n')
  assert.match(r.stderr, /No end of the turn within 2s/)
})
test('a refused send exits 1 and does not wait, and - reads the text from stdin', async t => {
  const w = world(t, (_k, text) => text.startsWith('long') ? { ok: true } : { refused: 'Kage has no session there' })
  await w.listening()
  const no = await w.kage(['thread', 'send', '--wait', 'C0TEST1:5.5', 'hi'])
  assert.equal(no.status, 1)
  assert.match(no.stderr, /Kage has no session there/)
  const piped = await w.kage(['thread', 'send', 'C0TEST1:5.5', '-'], 'long brief\nwith "quotes" and $vars\n')
  assert.equal(piped.status, 0, piped.stderr)
  assert.equal(w.told.at(-1), 'C0TEST1:5.5 long brief\nwith "quotes" and $vars')
  assert.equal((await w.kage(['thread', 'send', '--timeout', 'soon', 'C0TEST1:5.5', 'x'])).status, 2)
})

const follow = (w: World, args: string[]) => new Promise<Run>(res => {
  const c = spawn(process.execPath, [new URL('../watch.ts', import.meta.url).pathname, ...args], { env: { ...process.env, HOME: w.home, KAGE_ENV: join(w.dir, 'env'), NO_COLOR: '1' } })
  let stdout = '', stderr = ''
  c.stdout.on('data', b => { stdout += b })
  c.stderr.on('data', b => { stderr += b })
  c.on('close', status => res({ status, stdout, stderr }))
  setTimeout(() => c.kill(), 1500)
})

test('kage thread follow matches a place or key exactly, and --replies prints only replies', async t => {
  const w = world(t)
  writeFileSync(join(w.project, 'sess-b.jsonl'), replyLine('ops reply'))
  w.transcript(line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'thinking about it' }] } }))
  const general = await follow(w, ['#General'])
  assert.match(general.stdout, /an old reply/)
  assert.match(general.stdout, /thinking about it/)
  assert.doesNotMatch(general.stdout, /ops reply/)
  const replies = await follow(w, ['C0TEST1:5.5', '--replies'])
  assert.match(replies.stdout, /an old reply/)
  assert.doesNotMatch(replies.stdout, /thinking about it/)
  const none = await follow(w, ['#gen'])
  assert.equal(none.status, 1)
  assert.match(none.stderr, /No thread is "#gen"/)
})
