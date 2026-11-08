import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../core/sessions.ts'
import type { Task, ToSession } from './protocol.ts'
import { listenForSessions, restoreHolds, routeReply } from './session-link.ts'

const task = (content: string): Task => ({ type: 'task', content, fromOwner: true, meta: { channel: 'C1', thread_ts: '5.5', place: '#g', permalink: '' }, origin: { channel: 'C1', ts: '5.5' } })
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }

test('a terminal holds a thread for as long as it stays connected, then hands it back with what came meanwhile', async () => {
  const started: string[] = []
  const d = new Dispatcher<ToSession>(
    { start: k => started.push(k), stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1', saved: { A: 'id1' } },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  await until(() => server.listening)

  const c = connect(sock)
  let reply = ''
  c.on('data', b => { reply += b })
  c.write(JSON.stringify({ type: 'hold', key: 'A' }) + '\n')
  await until(() => reply.includes('\n'))
  assert.deepEqual(JSON.parse(reply), { type: 'hold', id: 'id1' })

  assert.equal(d.task('A', task('while away'), 0), 'held')
  assert.deepEqual(started, [])
  c.end()
  await until(() => started.length > 0)
  assert.deepEqual(started, ['A'])   // released on close: the waiting task starts the session again

  // An unknown thread is refused, and nothing is held for it.
  const c2 = connect(sock)
  let r2 = ''
  c2.on('data', b => { r2 += b })
  c2.write(JSON.stringify({ type: 'hold', key: 'Z' }) + '\n')
  await until(() => r2.includes('\n'))
  assert.deepEqual(JSON.parse(r2), { type: 'hold', refused: 'unknown' })
  c2.end()
  server.close()
})

test('a hold outlives a hub restart: the new hub holds the thread before any task, and the same terminal takes it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-link-'))
  const sock = join(dir, 's.sock')
  const hub = () => {
    const started: string[] = []
    const d = new Dispatcher<ToSession>(
      { start: k => started.push(k), stop: () => {}, lastActivity: () => 0, busy: () => false },
      { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'new', saved: { A: 'id1', B: 'id2' } },
    )
    return { d, started }
  }
  const ask = async (key: string, pid: number) => {
    const c = connect(sock)
    let r = ''
    c.on('data', b => { r += b })
    c.write(JSON.stringify({ type: 'hold', key, pid }) + '\n')
    await until(() => r.includes('\n'))
    return { c, reply: JSON.parse(r) }
  }

  // What a crashed hub leaves: a hold by this test process (playing the terminal, so alive) and one
  // whose terminal is gone.
  mkdirSync(join(dir, 'held'))
  writeFileSync(join(dir, 'held', encodeURIComponent('A')), String(process.pid))
  writeFileSync(join(dir, 'held', encodeURIComponent('B')), '999999999')

  // The restarted hub restores holds before anything else runs.
  const two = hub()
  restoreHolds(dir, two.d, Date.now())
  assert.equal(two.d.task('A', task('during restart'), 0), 'held')
  assert.equal(two.d.task('B', task('b'), 0), 'starting')   // the dead terminal's hold was dropped
  const s2 = listenForSessions(sock, two.d, { mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  await until(() => s2.listening)
  const other = await ask('A', 12345)
  assert.equal(other.reply.refused, 'held')   // another terminal may not take it
  other.c.end()
  const again = await ask('A', process.pid)
  assert.equal(again.reply.id, 'id1')                             // the same terminal reclaims it
  again.c.end()
  await until(() => two.started.includes('A'))
  assert.ok(!existsSync(join(dir, 'held', 'A')))
  s2.close()
})

test("a session's schedule always lands in its own thread, whatever key the message names", async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('A', task('a'), 0)
  const added: string[] = []
  const removed: string[] = []
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, {
    mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {},
    schedules: { add: (key, j) => { added.push(`${key} ${j.id} ${j.cron}`); return undefined }, remove: (key, id) => { removed.push(`${key} ${id}`) } },
  })
  await until(() => server.listening)
  const c = connect(sock)
  c.write(JSON.stringify({ type: 'hello', key: 'A' }) + '\n')
  c.write(JSON.stringify({ type: 'schedule', key: 'B', id: 'j1', cron: '*/15 * * * *', prompt: 'p', recurring: true, fromOwner: true }) + '\n')
  c.write(JSON.stringify({ type: 'unschedule', key: 'B', id: 'j1' }) + '\n')
  await until(() => removed.length > 0)
  assert.deepEqual(added, ['A j1 */15 * * * *'])
  assert.deepEqual(removed, ['A j1'])
  c.end()
  server.close()
})

test('the console reads the live board and stops a quiet session over the socket, and a session cannot', async () => {
  const stopped: string[] = []
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: k => stopped.push(k), lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('A', task('a'), 0)
  d.connect('A', () => {})
  d.task('B', task('b'), 0)
  d.connect('B', () => {})
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  await until(() => server.listening)
  const ask = async (m: object, hello?: string) => {
    const c = connect(sock)
    let r = ''
    c.on('data', b => { r += b })
    if (hello) c.write(JSON.stringify({ type: 'hello', key: hello }) + '\n')
    c.write(JSON.stringify(m) + '\n')
    await until(() => r.includes('\n'))
    c.end()
    return r ? JSON.parse(r) : undefined
  }
  const board = await ask({ type: 'board' })
  assert.equal(board.type, 'board')
  assert.equal(board.max, 3)
  assert.deepEqual(board.live.map((l: { key: string; state: string }) => [l.key, l.state]), [['A', 'quiet'], ['B', 'quiet']])

  assert.deepEqual(await ask({ type: 'stop', key: 'A' }), { type: 'stop', ok: true })
  assert.deepEqual(stopped, ['A'])
  assert.deepEqual(await ask({ type: 'stop', key: 'A' }), { type: 'stop', refused: 'closed' })
  // A thread's own session may not close another one.
  await ask({ type: 'stop', key: 'B' }, 'B')
  assert.deepEqual(stopped, ['A'])
  server.close()
})

test('the console tells a thread something as the owner, and a session cannot', async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('B', task('b'), 0)
  d.connect('B', () => {})
  const told: [string, string][] = []
  const tell = (key: string, text: string) => key === 'A' ? (told.push([key, text]), { ok: true as const }) : { refused: 'no thread with that key' }
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, tell })
  await until(() => server.listening)
  const ask = async (m: object, hello?: string) => {
    const c = connect(sock)
    let r = ''
    c.on('data', b => { r += b })
    if (hello) c.write(JSON.stringify({ type: 'hello', key: hello }) + '\n')
    c.write(JSON.stringify(m) + '\n')
    await until(() => r.includes('\n'))
    c.end()
    return r ? JSON.parse(r) : undefined
  }
  assert.deepEqual(await ask({ type: 'tell', key: 'A', text: 'use the staging db' }), { type: 'tell', ok: true })
  assert.deepEqual(told, [['A', 'use the staging db']])
  assert.deepEqual(await ask({ type: 'tell', key: 'Z', text: 'hi' }), { type: 'tell', refused: 'no thread with that key' })
  assert.deepEqual(await ask({ type: 'tell', key: 'A', text: '   ' }), { type: 'tell', refused: 'empty message' })
  // A thread's own session may not speak as the owner in another thread.
  await ask({ type: 'tell', key: 'A', text: 'from a session' }, 'B')
  assert.deepEqual(told, [['A', 'use the staging db']])
  server.close()
})
test('a voice code goes to the owner by DM, and the asker only learns it was sent', async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const base = { mail: () => {}, wa: () => {}, voice: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } }
  const ask = async (sock: string) => {
    const c = connect(sock)
    let r = ''
    c.on('data', b => { r += b })
    c.write(JSON.stringify({ type: 'voicecode' }) + '\n')
    await until(() => r.includes('\n'))
    c.end()
    return JSON.parse(r)
  }
  const dir = mkdtempSync(join(tmpdir(), 'kage-link-'))
  let sent = 0
  const on = listenForSessions(join(dir, 'a.sock'), d, { ...base, voiceCode: async () => (sent++, { ok: true as const }) })
  const off = listenForSessions(join(dir, 'b.sock'), d, base)
  await until(() => on.listening && off.listening)
  assert.deepEqual(await ask(join(dir, 'a.sock')), { type: 'voicecode', ok: true })
  assert.equal(sent, 1)
  assert.deepEqual(await ask(join(dir, 'b.sock')), { type: 'voicecode', refused: 'voice is off' })
  on.close()
  off.close()
})
test('a voice reply goes only to a voice conversation, and a mail or WhatsApp reply never does', () => {
  const got: string[] = []
  const o = { mail: (k: string) => got.push(`mail ${k}`), wa: (k: string) => got.push(`wa ${k}`), voice: (k: string, t: string) => got.push(`voice ${k} ${t}`) }
  routeReply('voice:abc', { type: 'voice', text: 'hi' }, o)
  routeReply('mail:<a@b>', { type: 'voice', text: 'x' }, o)
  routeReply('wa:1', { type: 'voice', text: 'x' }, o)
  routeReply('voice:abc', { type: 'mail', text: 'x' }, o)
  assert.deepEqual(got, ['voice voice:abc hi'])
})
