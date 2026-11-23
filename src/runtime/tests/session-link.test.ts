import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import type { ToSession } from '../protocol.ts'
import { listenForSessions, restoreHolds, routeReply } from '../session-link.ts'

const task = (content: string): Task => ({ type: 'task', content, fromOwner: true, meta: { channel: 'C1', thread_ts: '5.5', place: '#g', permalink: '' }, origin: { channel: 'C1', ts: '5.5' } })
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }

test('a terminal holds a thread for as long as it stays connected, then hands it back with what came meanwhile', async () => {
  const started: string[] = []
  const d = new Dispatcher<ToSession>(
    { start: k => started.push(k), stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1', saved: { A: 'id1' } },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
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
  assert.deepEqual(started, ['A'])

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

  mkdirSync(join(dir, 'held'))
  writeFileSync(join(dir, 'held', encodeURIComponent('A')), String(process.pid))
  writeFileSync(join(dir, 'held', encodeURIComponent('B')), '999999999')

  const two = hub()
  restoreHolds(dir, two.d)
  assert.equal(two.d.task('A', task('during restart'), 0), 'held')
  assert.equal(two.d.task('B', task('b'), 0), 'starting')
  const s2 = listenForSessions(sock, two.d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  await until(() => s2.listening)
  const other = await ask('A', 12345)
  assert.equal(other.reply.refused, 'held')
  other.c.end()
  const live = await ask('A', process.ppid)
  assert.equal(live.reply.refused, 'held')
  live.c.end()
  const again = await ask('A', process.pid)
  assert.equal(again.reply.id, 'id1')
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
    mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {},
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

test("a job lane's session cannot unschedule over the socket", async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('C1:5.5#side-job-j1', task('a'), 0)
  const removed: string[] = []
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, {
    mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {},
    schedules: { add: () => undefined, remove: (key, id) => { removed.push(`${key} ${id}`) } },
  })
  await until(() => server.listening)
  const c = connect(sock)
  c.write(JSON.stringify({ type: 'hello', key: 'C1:5.5#side-job-j1' }) + '\n')
  c.write(JSON.stringify({ type: 'unschedule', key: 'x', id: 'j1' }) + '\n')
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(removed, [])
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
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
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
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, tell })
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
  await ask({ type: 'tell', key: 'A', text: 'from a session' }, 'B')
  assert.deepEqual(told, [['A', 'use the staging db']])
  server.close()
})
test("kage say: an app on this Mac posts the owner's words, and a session cannot", async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('B', task('b'), 0)
  d.connect('B', () => {})
  const said: unknown[] = []
  const say = async (text: string, at?: object) => (said.push([text, at]), { ok: true as const, channel: 'DTEST', ts: '9.9' })
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, say })
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
  assert.deepEqual(await ask({ type: 'say', text: ' how many signups? ' }), { type: 'say', ok: true, channel: 'DTEST', ts: '9.9' })
  assert.deepEqual(await ask({ type: 'say', text: 'and yesterday?', channel: 'CTEST2', thread_ts: '7.7' }), { type: 'say', ok: true, channel: 'DTEST', ts: '9.9' })
  assert.deepEqual(await ask({ type: 'say', text: '  ' }), { type: 'say', refused: 'empty message' })
  assert.deepEqual(await ask({ type: 'say', text: 'hi', channel: 'CTEST2' }), { type: 'say', refused: 'a reply needs both channel and thread_ts' })
  await ask({ type: 'say', text: 'from a session' }, 'B')
  assert.deepEqual(said, [['how many signups?', undefined], ['and yesterday?', { channel: 'CTEST2', thread_ts: '7.7' }]])
  server.close()
})
test('kage top runs, pauses, resumes and removes a kagelet through the manager; it cannot save one, and a session cannot act', async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('B', task('b'), 0)
  d.connect('B', () => {})
  const done: string[] = []
  const kagelet = async (action: string, name: string) => { done.push(`${action} ${name}`); return `${name}: ${action} done` }
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, kagelet })
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
  try {
    for (const action of ['run', 'pause', 'resume', 'remove', 'revoke']) assert.deepEqual(await ask({ type: 'kagelet', action, name: 'deploys' }), { type: 'kagelet', text: `deploys: ${action} done` })
    assert.deepEqual(await ask({ type: 'kagelet', action: 'save', name: 'deploys' }), { type: 'kagelet', refused: 'kage top runs, pauses, resumes or removes a kagelet, revokes the standing approval, or lifts deny holds, not save' })
    await ask({ type: 'kagelet', action: 'remove', name: 'deploys' }, 'B')
    assert.deepEqual(done, ['run deploys', 'pause deploys', 'resume deploys', 'remove deploys', 'revoke deploys'])
  } finally { server.close() }
})

test('a reply goes only to a conversation of its own channel: a text never reaches a voice, mail or WhatsApp session, nor they a text one', () => {
  const got: string[] = []
  const o = { mail: (k: string) => got.push(`mail ${k}`), wa: (k: string) => got.push(`wa ${k}`), voice: (k: string, t: string) => got.push(`voice ${k} ${t}`), sms: (k: string, t: string) => got.push(`sms ${k} ${t}`) }
  routeReply('voice:abc', { type: 'voice', text: 'hi' }, o)
  routeReply('mail:<a@b>', { type: 'voice', text: 'x' }, o)
  routeReply('wa:1', { type: 'voice', text: 'x' }, o)
  routeReply('voice:abc', { type: 'mail', text: 'x' }, o)
  routeReply('sms:7', { type: 'sms', text: 'open at 9' }, o)
  routeReply('wa:1', { type: 'sms', text: 'x' }, o)
  routeReply('sms:7', { type: 'wa', text: 'x' }, o)
  assert.deepEqual(got, ['voice voice:abc hi', 'sms sms:7 open at 9'])
})

test('kage reload: the socket answers with what the hub did with the settings file', async t => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const answers = [{ changed: ['KAGE_TEAMMATES: added UTEST0002'], restart: ['KAGE_NAME'], count: 1 }, { refused: 'KAGE_TEAMMATES has "priya"' }]
  let asked = 0
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, reload: () => answers[asked++]! })
  t.after(() => server.close())
  await until(() => server.listening)
  const ask = async () => {
    const c = connect(sock)
    let reply = ''
    c.on('data', b => { reply += b })
    c.write(JSON.stringify({ type: 'reload' }) + '\n')
    await until(() => reply.includes('\n'))
    c.destroy()
    return JSON.parse(reply || 'null')
  }
  assert.deepEqual(await ask(), { type: 'reload', changed: ['KAGE_TEAMMATES: added UTEST0002'], restart: ['KAGE_NAME'], count: 1 })
  assert.deepEqual(await ask(), { type: 'reload', refused: 'KAGE_TEAMMATES has "priya"' })
  assert.equal(asked, 2)
})

test('the board says when the usage limit paused Kage, and carries the limit counts', async t => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  let paused: { until: number; held: number } | undefined = { until: 5000, held: 2 }
  const counts = { limitHits: 1, held: 2, replays: 0, replayFailures: 0 }
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, paused: () => paused, limitCounts: () => counts })
  t.after(() => server.close())
  await until(() => server.listening)
  const ask = async () => {
    const c = connect(sock)
    let reply = ''
    c.on('data', b => { reply += b })
    c.write(JSON.stringify({ type: 'board' }) + '\n')
    await until(() => reply.includes('\n'))
    c.destroy()
    return JSON.parse(reply || 'null')
  }
  assert.deepEqual(await ask(), { type: 'board', live: [], waiting: [], held: [], max: 2, paused: { until: 5000, held: 2 }, limitCounts: counts })
  paused = undefined
  assert.deepEqual(await ask(), { type: 'board', live: [], waiting: [], held: [], max: 2, limitCounts: counts })
})

test('kage restart and stop ask the hub to drain, and hear which threads they wait on', async t => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const waits = [[{ key: 'C1:5.5', why: 'busy' }], []]
  let asked = 0
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, quiesce: () => waits[asked++]! })
  t.after(() => server.close())
  await until(() => server.listening)
  const ask = async () => {
    const c = connect(sock)
    let reply = ''
    c.on('data', b => { reply += b })
    c.write(JSON.stringify({ type: 'quiesce' }) + '\n')
    await until(() => reply.includes('\n'))
    c.destroy()
    return JSON.parse(reply || 'null')
  }
  assert.deepEqual(await ask(), { type: 'quiesce', waiting: [{ key: 'C1:5.5', why: 'busy' }] })
  assert.deepEqual(await ask(), { type: 'quiesce', waiting: [] })
  assert.equal(asked, 2)
})

test('kage stop <thread> asks the hub to end one session, after its turn or now', async t => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, end: (key, cut) => `${key} cut=${cut}` })
  t.after(() => server.close())
  await until(() => server.listening)
  const ask = async (m: object) => {
    const c = connect(sock)
    let reply = ''
    c.on('data', b => { reply += b })
    c.write(JSON.stringify(m) + '\n')
    await until(() => reply.includes('\n'))
    c.destroy()
    return JSON.parse(reply || 'null')
  }
  assert.deepEqual(await ask({ type: 'end', key: 'C1:5.5' }), { type: 'end', text: 'C1:5.5 cut=false' })
  assert.deepEqual(await ask({ type: 'end', key: 'C1:5.5', cut: true }), { type: 'end', text: 'C1:5.5 cut=true' })
})

test('the console lists, allows and denies relay threads, and a session cannot', async () => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  d.task('B', task('b'), 0)
  d.connect('B', () => {})
  const calls: string[] = []
  const relay = (action: string, key?: string) => (calls.push(`${action} ${key ?? ''}`), { ok: true as const, keys: ['A'] })
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, relay })
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
  assert.deepEqual(await ask({ type: 'relay', action: 'allow', key: 'A' }), { type: 'relay', ok: true, keys: ['A'] })
  assert.deepEqual(await ask({ type: 'relay', action: 'list' }), { type: 'relay', ok: true, keys: ['A'] })
  assert.equal((await ask({ type: 'relay', action: 'wipe', key: 'A' })).refused !== undefined, true)
  await ask({ type: 'relay', action: 'allow', key: 'B' }, 'B')
  assert.deepEqual(calls, ['allow A', 'list '])
  server.close()
})

test('a health question gets the connector lines the hub keeps in memory (#256)', async t => {
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, { mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, health: () => ['email     on · last heard 2m ago'] })
  t.after(() => server.close())
  await until(() => server.listening)
  const c = connect(sock)
  let reply = ''
  c.on('data', b => { reply += b })
  c.write(JSON.stringify({ type: 'health' }) + '\n')
  await until(() => reply.includes('\n'))
  c.destroy()
  assert.deepEqual(JSON.parse(reply), { type: 'health', lines: ['email     on · last heard 2m ago'] })
})

test('only a connected session acts as one: a holder or a socket with no hello gets no answer and changes nothing, a refused hello is cut, and a session asks for permission', async t => {
  const stopped: string[] = [], removed: string[] = [], added: string[] = []
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: k => stopped.push(k), lastActivity: () => 0, busy: () => false },
    { max: 3, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1', saved: { H: 'idH' } },
  )
  d.task('A', task('a'), 0)
  d.task('B', task('b'), 0)
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-link-')), 's.sock')
  const server = listenForSessions(sock, d, {
    mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {},
    schedules: { add: (key, j) => { added.push(`${key} ${j.id}`); return undefined }, remove: (key, id) => { removed.push(`${key} ${id}`) } },
  })
  await until(() => server.listening)
  const sockets: ReturnType<typeof connect>[] = []
  t.after(() => { for (const c of sockets) c.destroy(); server.close() })
  const open = () => {
    const c = connect(sock), got: string[] = []
    sockets.push(c)
    let closed = false
    c.on('data', b => got.push(...String(b).split('\n').filter(Boolean)))
    c.on('close', () => { closed = true })
    const say = (m: object) => c.write(JSON.stringify(m) + '\n')
    return { c, got, say, closed: () => closed }
  }

  const holder = open()
  holder.say({ type: 'hold', key: 'H' })
  await until(() => holder.got.length > 0)
  holder.say({ type: 'stop', key: 'B' })
  holder.say({ type: 'board' })
  holder.say({ type: 'callcode' })
  const stranger = open()
  stranger.say({ type: 'permission', id: 'p0' })
  stranger.say({ type: 'unschedule', id: 'j1' })
  stranger.say({ type: 'schedule', id: 'j2', cron: '* * * * *', prompt: 'x' })
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(holder.got.map(l => JSON.parse(l).type), ['hold'])
  assert.deepEqual([stopped, removed, added], [[], [], []])
  assert.equal(d.verdict('p0', { type: 'task' } as unknown as ToSession), false)

  const nobody = open()
  nobody.say({ type: 'hello', key: 'nobody' })
  await until(() => nobody.closed())
  assert.ok(nobody.closed())

  const session = open()
  session.say({ type: 'hello', key: 'A' })
  session.say({ type: 'permission', id: 'p1' })
  await until(() => d.verdict('p1', { type: 'verdict' } as unknown as ToSession))
  await until(() => session.got.length > 1)
  assert.deepEqual(session.got.map(l => JSON.parse(l).type), ['task', 'verdict'])

  const code = open()
  code.say({ type: 'callcode' })
  await until(() => code.got.length > 0)
  assert.deepEqual(JSON.parse(code.got[0]!), { type: 'callcode', refused: 'voice is off' })
})
