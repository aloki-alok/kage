import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../../runtime/store.ts'

const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>(res =>
  execFile(process.execPath, [new URL('../trust.ts', import.meta.url).pathname, ...args], { env, encoding: 'utf8', timeout: 30_000 },
    (e, stdout, stderr) => res({ code: e ? Number(e.code ?? 1) : 0, out: stdout + stderr })))

test('kage trust lists the lines, and revoke asks the hub with an owner key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-trust-cli-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  writeFileSync(join(dir, 'owner.key'), 'ab'.repeat(32))
  const store = openStore(join(dir, 'kage.db'))
  const base = { who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', answer: 'yes' as const, once: false, link: 'l' }
  store.addTrustLine(base, 1_000)
  store.addTrustLine({ ...base, who: 'UTEAM0002' }, 2_000)
  store.close()
  const asked: Record<string, unknown>[] = []
  const hub = createServer(s => s.on('data', b => {
    const m = JSON.parse(String(b).split('\n')[0]!) as Record<string, unknown>
    asked.push(m)
    s.end(JSON.stringify({ type: 'trust', ...(m.id === 'T9' ? { refused: 'no line T9 to revoke' } : { ok: true, text: `done ${m.id}` }) }) + '\n')
  })).listen(join(dir, 'router.sock'))
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))
  const { KAGE_THREAD: _, KAGE_SESSION: __, KAGE_CLAUDE: ___, ...clean } = process.env
  const env = { ...clean, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1' }

  const all = await run(['list'], env)
  assert.equal(all.code, 0, all.out)
  assert.match(all.out, /UTEAM0001.*live/)
  assert.match(all.out, /UTEAM0002.*live/)

  const ok = await run(['revoke', 'T1'], env)
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /done T1/)
  const revoke = await run(['revoke', 'T9'], env)
  assert.equal(revoke.code, 1)
  assert.match(revoke.out, /Refused: no line T9 to revoke/)
  assert.deepEqual(asked.map(m => [m.type, m.action, m.id, m.ownerKey]), [['trust', 'revoke', 'T1', 'ab'.repeat(32)], ['trust', 'revoke', 'T9', 'ab'.repeat(32)]])

  const inSession = await run(['revoke', 'T1'], { ...env, KAGE_CLAUDE: '1' })
  assert.equal(inSession.code, 1)
  assert.equal(asked.length, 2)
  assert.equal((await run([], env)).code, 1)
})
