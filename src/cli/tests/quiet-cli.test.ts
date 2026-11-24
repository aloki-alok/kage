import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('kage restart against a hub that never answers exits 1 and cuts nothing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-silent-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  let asks = 0
  const hub = createServer(s => s.on('data', () => { asks++ })).listen(join(dir, 'router.sock'))
  t.after(() => hub.close())
  await new Promise(r => hub.once('listening', r))
  const { KAGE_THREAD: _, KAGE_SESSION: __, KAGE_CLAUDE: ___, ...base } = process.env
  const env = { ...base, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1' }
  const { code, out } = await new Promise<{ code: number; out: string }>(res =>
    execFile(process.execPath, [new URL('../quiet.ts', import.meta.url).pathname, 'restart'], { env, encoding: 'utf8', timeout: 90_000 },
      (e, stdout, stderr) => res({ code: e ? Number(e.code ?? 1) : 0, out: stdout + stderr })))
  assert.equal(code, 1, out)
  assert.match(out, /^The hub did not answer\. Nothing was cut\. To restart anyway and cut every running turn: kage restart --cut-running$/m)
  assert.doesNotMatch(out, /Cutting|older/)
  assert.equal(asks, 5)
})
