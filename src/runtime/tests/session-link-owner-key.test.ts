import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import type { ToSession } from '../protocol.ts'
import { linkToken, readToken } from '../owner-key.ts'
import { listenForSessions } from '../session-link.ts'

const KEY = 'a1'.repeat(32)
const task = (content: string): Task => ({ type: 'task', content, fromOwner: true, meta: { channel: 'C1', thread_ts: '5.5', place: '#g', permalink: '' }, origin: { channel: 'C1', ts: '5.5' } })
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }

const READ_COMMANDS: Record<string, object> = { board: {}, health: {} }
const OWNER_COMMANDS: Record<string, object> = {
  ...READ_COMMANDS, hold: { key: 'H', pid: process.pid }, end: { key: 'A' }, quiesce: {}, reload: {}, callcode: {},
  tell: { key: 'A', text: 'deploy prod' }, say: { text: 'hi' }, relay: { action: 'allow', key: 'A' }, trust: { action: 'revoke', id: 'T1' }, kagelet: { action: 'run', name: 'deploys' }, stop: { key: 'A' },
}

function hub(t: { after: (f: () => void) => void }) {
  const acted: string[] = []
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: k => acted.push(`stop ${k}`), lastActivity: () => 0, busy: () => false },
    { max: 4, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1', saved: { H: 'idH' } },
  )
  d.task('A', task('a'), 0)
  d.connect('A', () => {})
  d.task('B', task('for B only'), 0)
  const did = <T>(name: string, r: T) => () => (acted.push(name), r)
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-key-')), 's.sock')
  const server = listenForSessions(sock, d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    tell: did('tell', { ok: true as const }), say: did('say', Promise.resolve({ ok: true as const, channel: 'DTEST', ts: '1.1' })), relay: did('relay', { ok: true as const, keys: [] }), trust: did('trust', { ok: true as const, text: 'revoked T1' }),
    reload: did('reload', { changed: [], restart: [], count: 0 }), paused: did('board', undefined), health: did('health', []), end: did('end', 'ended'),
    quiesce: did('quiesce', []), callCode: did('callcode', '1234'), kagelet: did('kagelet', Promise.resolve('done')),
  })
  t.after(() => server.close())
  const open = () => {
    const c = connect(sock), got: string[] = []
    let closed = false
    c.on('data', b => got.push(...String(b).split('\n').filter(Boolean)))
    c.on('close', () => { closed = true })
    t.after(() => c.destroy())
    return { got, closed: () => closed, send: (m: object) => c.write(JSON.stringify(m) + '\n') }
  }
  const ask = async (m: object) => {
    const c = open()
    c.send(m)
    await until(() => c.got.length > 0)
    return c.got[0] ? JSON.parse(c.got[0]) : undefined
  }
  return { d, acted, ask, open, listening: () => until(() => server.listening) }
}

test('a connection without the owner key is refused every owner command, and nothing acts; the kage command with the key is answered', async t => {
  const h = hub(t)
  await h.listening()
  for (const [type, args] of Object.entries(OWNER_COMMANDS)) {
    for (const ownerKey of [undefined, '', 'b2'.repeat(32), KEY.slice(0, -1), 42]) {
      const r = await h.ask({ type, ...args, ...ownerKey !== undefined && { ownerKey } })
      assert.equal(r?.type, type, `${type} with ${String(ownerKey)}: no answer`)
      assert.match(r.refused ?? '', type in READ_COMMANDS ? /kage status works in the owner's threads and terminal/ : /owner key/, `${type} with ${String(ownerKey)} was not refused`)
    }
  }
  assert.deepEqual(h.acted, [])
  assert.deepEqual(h.d.status(0).held, [])

  for (const [type, args] of Object.entries(OWNER_COMMANDS)) {
    const r = await h.ask({ type, ...args, ownerKey: KEY })
    assert.equal(r?.type, type, `${type} with the key: no answer`)
    assert.doesNotMatch(r.refused ?? '', /owner key/, `${type} with the key was refused`)
  }
  assert.deepEqual([...h.acted].sort(), ['board', 'callcode', 'end', 'health', 'kagelet', 'quiesce', 'relay', 'reload', 'say', 'stop A', 'tell', 'trust'])
  assert.deepEqual(h.d.status(0).held, ['H'])
})

test("hello binds a connection only to the thread whose link token it brings, so a session cannot take another thread's tasks", async t => {
  const h = hub(t)
  await h.listening()
  for (const token of [undefined, '', linkToken(KEY, 'A'), linkToken('c3'.repeat(32), 'B')]) {
    const thief = h.open()
    thief.send({ type: 'hello', key: 'B', ...token !== undefined && { linkToken: token } })
    await until(() => thief.closed())
    assert.ok(thief.closed(), `a hello for B with ${String(token)} was not cut`)
    assert.deepEqual(thief.got, [])
  }
  const own = h.open()
  own.send({ type: 'hello', key: 'B', linkToken: linkToken(KEY, 'B') })
  await until(() => own.got.length > 0)
  assert.deepEqual(own.got.map(l => JSON.parse(l).content), ['for B only'])
  assert.ok(!own.closed())
})

test("an owner thread's read token answers kage status and the board, and is refused every owner write", async t => {
  const h = hub(t)
  await h.listening()
  const read = readToken(KEY)
  assert.notEqual(read, KEY)
  assert.notEqual(read, linkToken(KEY, 'A'))
  for (const [type, args] of Object.entries(OWNER_COMMANDS)) {
    const r = await h.ask({ type, ...args, readToken: read })
    if (type in READ_COMMANDS) assert.equal(r.refused, undefined, `${type} with the read token was refused`)
    else assert.match(r.refused ?? '', /owner key/, `${type} took the read token`)
  }
  assert.deepEqual([...h.acted].sort(), ['board', 'health'])
  assert.match((await h.ask({ type: 'board', readToken: linkToken(KEY, 'A') })).refused ?? '', /owner's threads/)
})
