import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../../core/sessions.ts'
import type { ToSession } from '../../../runtime/protocol.ts'
import { listenForSessions } from '../../../runtime/session-link.ts'

const dir = mkdtempSync(join(tmpdir(), 'kage-doctor-key-'))
process.env.KAGE_ENV = join(dir, 'env')
delete process.env.KAGE_SESSION
delete process.env.KAGE_THREAD
const { hubKey } = await import('../hub-key.ts')
const KEY = 'f6'.repeat(32)

test("the doctor asks the running hub with this terminal's key: ok when it matches, a FAIL with the fix when owner.key is missing or changed, nothing when the hub is down or in a session", async t => {
  assert.deepEqual(await hubKey(), [], 'a stopped hub gave a line')
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' })
  const hub = listenForSessions(join(dir, 'router.sock'), d, { ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} } })
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))

  writeFileSync(join(dir, 'owner.key'), KEY, { mode: 0o600 })
  assert.deepEqual((await hubKey()).map(l => l.kind), ['ok'])
  const fix = /owner\.key is missing or changed since the hub started\. Run kage restart --cut-running/
  for (const file of ['a7'.repeat(32), '']) {
    writeFileSync(join(dir, 'owner.key'), file, { mode: 0o600 })
    const lines = await hubKey()
    assert.deepEqual(lines.map(l => l.kind), ['fail'], `owner.key "${file.slice(0, 4)}"`)
    assert.match(lines[0]!.text, fix)
    assert.equal(lines[0]!.fix, undefined, 'doctor --fix must not cut running turns')
  }
  process.env.KAGE_SESSION = '1'
  try { assert.deepEqual(await hubKey(), []) } finally { delete process.env.KAGE_SESSION }
})

test('a hub that never answers, or a socket file left by a hub that died, adds no doctor line, so the soak gate stays All good', async t => {
  rmSync(join(dir, 'router.sock'), { force: true })
  writeFileSync(join(dir, 'router.sock'), '')
  assert.deepEqual(await hubKey(), [], 'a stale socket file gave a line')
  rmSync(join(dir, 'router.sock'), { force: true })
  const hung = createServer(() => {}).listen(join(dir, 'router.sock'))
  t.after(() => hung.close())
  await new Promise(r => hung.once('listening', r))
  assert.deepEqual(await hubKey(), [], 'a hub that never answers gave a line')
})
