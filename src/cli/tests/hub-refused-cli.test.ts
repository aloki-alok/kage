import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../../core/sessions.ts'
import { readToken } from '../../runtime/owner-key.ts'
import type { ToSession } from '../../runtime/protocol.ts'
import { listenForSessions } from '../../runtime/session-link.ts'
import { openStore } from '../../runtime/store.ts'

const run = (cli: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>(res =>
  execFile(process.execPath, [new URL(`../${cli}`, import.meta.url).pathname, ...args], { env, encoding: 'utf8', timeout: 30_000 },
    (e, stdout, stderr) => res({ code: e ? Number(e.code ?? 1) : 0, out: stdout + stderr })))

test('kage top --once and kage status say in plain words when the hub refuses them, and finish', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-refused-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  openStore(join(dir, 'kage.db')).saveSessions({ 'C1:5.5': 'id1' })
  const asked: string[] = []
  const hub = createServer(s => s.on('data', b => {
    const m = JSON.parse(String(b).split('\n')[0]!) as { type: string }
    asked.push(m.type)
    s.end(JSON.stringify({ type: m.type, refused: 'this needs the owner key' }) + '\n')
  })).listen(join(dir, 'router.sock'))
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))
  const { KAGE_THREAD: _, KAGE_SESSION: __, KAGE_CLAUDE: ___, ...base } = process.env
  const env = { ...base, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1' }

  const top = await run('top.ts', ['--once'], env)
  assert.equal(top.code, 0, top.out)
  assert.match(top.out, /Kage refused this: this needs the owner key\./)
  const status = await run('status.ts', [], env)
  assert.equal(status.code, 0, status.out)
  assert.match(status.out, /Kage refused this: this needs the owner key\./)
  const stop = await run('stop.ts', ['C1:5.5'], env)
  assert.equal(stop.code, 1, stop.out)
  assert.match(stop.out, /Kage refused this: this needs the owner key\./)
  const drain = await run('quiet.ts', ['restart'], env)
  assert.equal(drain.code, 1, drain.out)
  assert.match(drain.out, /Nothing was cut\. owner\.key is likely missing or changed since the hub started\. To restart anyway and cut every running turn: kage restart --cut-running/)
  for (const r of [stop, drain]) assert.doesNotMatch(r.out, /older/)
  for (const r of [top, status, stop]) assert.match(r.out, /In your own terminal, that means owner\.key is missing or changed since the hub started: run kage restart --cut-running\./)
  for (const r of [top, status, stop, drain]) assert.equal(r.out.match(/--cut-running/g)?.length, 1, r.out)
  assert.ok(['board', 'health', 'end', 'quiesce'].every(type => asked.includes(type)), asked.join(' '))
})

test("kage status in an owner thread's session reads the hub with its read token, and a teammate thread's session is refused", async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-readtoken-')), KEY = 'e5'.repeat(32)
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  openStore(join(dir, 'kage.db'))
  const d = new Dispatcher<ToSession>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 2, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id1' })
  const hub = listenForSessions(join(dir, 'router.sock'), d, { ownerKey: KEY, mail: () => {}, wa: () => {}, voice: () => {}, sms: () => {}, gh: () => {}, failed: () => {}, schedules: { add: () => undefined, remove: () => {} }, health: () => ['email     on'] })
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))
  const { KAGE_THREAD: _, KAGE_CLAUDE: __, KAGE_READ_TOKEN: ___, ...base } = process.env
  const session = { ...base, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_SESSION: '1' }

  const owner = await run('status.ts', [], { ...session, KAGE_READ_TOKEN: readToken(KEY) })
  assert.equal(owner.code, 0, owner.out)
  assert.match(owner.out, /Connectors\n {2}email {5}on/)
  assert.doesNotMatch(owner.out, /refused/)
  const teammate = await run('status.ts', [], session)
  assert.equal(teammate.code, 0, teammate.out)
  assert.match(teammate.out, /Kage refused this: kage status works in the owner's threads and terminal\./)
  assert.doesNotMatch(teammate.out, /email {5}on/)
  assert.doesNotMatch(teammate.out, /kage restart|owner\.key/, 'a session was told to restart Kage')
})
