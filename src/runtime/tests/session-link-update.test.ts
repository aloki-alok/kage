import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import type { ToSession } from '../protocol.ts'
import { linkToken, readToken } from '../owner-key.ts'
import { listenForSessions } from '../session-link.ts'

const KEY = 'a1'.repeat(32)
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }

function hub(t: { after: (f: () => void) => void }) {
  const asked: boolean[] = []
  const d = new Dispatcher<ToSession>(
    { start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 4, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1', saved: {} },
  )
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-upd-')), 's.sock')
  const server = listenForSessions(sock, d, {
    ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} },
    update: async stable => { asked.push(stable); return { moved: { old: 'aaa', new: 'bbb', packages: false, subjects: ['feat: x'] } } },
  })
  t.after(() => server.close())
  const ask = async (m: object) => {
    await until(() => server.listening)
    const c = connect(sock), got: string[] = []
    c.on('data', b => got.push(...String(b).split('\n').filter(Boolean)))
    t.after(() => c.destroy())
    c.write(JSON.stringify(m) + '\n')
    await until(() => got.length > 0)
    return got[0] ? JSON.parse(got[0]) : undefined
  }
  return { asked, ask }
}

test("an owner thread's read token updates the hub, and the answer says what moved", async t => {
  const h = hub(t)
  const r = await h.ask({ type: 'update', readToken: readToken(KEY) })
  assert.deepEqual(r, { type: 'update', moved: { old: 'aaa', new: 'bbb', packages: false, subjects: ['feat: x'] } })
  assert.deepEqual(h.asked, [false])
})

test('the owner key updates, and only a true stable asks for the release', async t => {
  const h = hub(t)
  await h.ask({ type: 'update', ownerKey: KEY, stable: true })
  await h.ask({ type: 'update', ownerKey: KEY, stable: 'main' })
  assert.deepEqual(h.asked, [true, false])
})

test('no token, a teammate or pane link token, a wrong read token and a wrong key are refused, and nothing updates', async t => {
  const h = hub(t)
  for (const m of [{}, { readToken: '' }, { readToken: linkToken(KEY, 'A') }, { readToken: readToken('b2'.repeat(32)) }, { ownerKey: KEY.slice(1) }, { linkToken: linkToken(KEY, 'A'), key: 'A' }, { readToken: 7 }]) {
    const r = await h.ask({ type: 'update', ...m })
    assert.match(r?.refused ?? '', /owner's threads and terminal/, JSON.stringify(m))
  }
  assert.deepEqual(h.asked, [])
})

test('a hub with no update hook refuses instead of staying silent', async t => {
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 1, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'x', saved: {} })
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-upd-')), 's.sock')
  const server = listenForSessions(sock, d, { ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  t.after(() => server.close())
  await until(() => server.listening)
  const c = connect(sock), got: string[] = []
  c.on('data', b => got.push(String(b)))
  t.after(() => c.destroy())
  c.write(JSON.stringify({ type: 'update', ownerKey: KEY }) + '\n')
  await until(() => got.length > 0)
  assert.match(got[0]!, /cannot update itself/)
})
