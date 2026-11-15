import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pin, runProbe } from '../probes.ts'

const o = { timeoutMs: 5000, maxBytes: 1024 }
const probe = (command: string, pins: Record<string, string> = {}) => ({ command, pins, ignore: [] })

describe('runProbe', () => {
  test('returns the output and ok for a command that exits 0', async () => {
    const r = await runProbe(probe('printf hello'), o)
    assert.deepEqual([r.ok, r.out, r.refused], [true, 'hello', undefined])
    assert.ok(r.ms >= 0)
  })
  test('is not ok when the command exits non-zero, and keeps its output', async () => {
    const r = await runProbe(probe('printf oops; exit 3'), o)
    assert.deepEqual([r.ok, r.out], [false, 'oops'])
  })
  test('kills a command that outlives the timeout, children included', async () => {
    const t = Date.now()
    const r = await runProbe(probe('sleep 30 & sleep 30'), { ...o, timeoutMs: 200 })
    assert.equal(r.ok, false)
    assert.ok(Date.now() - t < 3000, 'returned long after the timeout')
  })
  test('truncates output past maxBytes and marks it', async () => {
    const r = await runProbe(probe("head -c 100000 /dev/zero | tr '\\0' a"), { ...o, maxBytes: 100 })
    assert.equal(r.out, 'a'.repeat(100) + '\n[truncated]')
  })
  test('never throws, even when the home folder does not exist', async () => {
    const r = await runProbe(probe('printf x'), { ...o, home: '/no/such/dir' })
    assert.equal(typeof r.ok, 'boolean')
  })
})

describe('pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'))
  const script = join(dir, 'check.sh')
  writeFileSync(script, 'printf one')

  test('pin hashes an existing script and skips a missing path', () => {
    const p = pin(`/bin/sh ${script} /no/such/file`)
    assert.deepEqual(Object.keys(p).sort(), ['/bin/sh', script].sort())
    assert.match(p[script]!, /^[0-9a-f]{64}$/)
  })
  test('a pinned script runs, then is refused after an edit, with its path named', async () => {
    const command = `/bin/sh ${script}`
    const p = probe(command, pin(command))
    assert.equal((await runProbe(p, o)).out, 'one')
    writeFileSync(script, 'printf two')
    const r = await runProbe(p, o)
    assert.equal(r.ok, false)
    assert.match(r.refused!, new RegExp(script))
    assert.equal(r.out, '')
  })
  test('is refused when a pinned file is gone', async () => {
    const gone = join(dir, 'gone.sh')
    writeFileSync(gone, 'x')
    const command = `/bin/sh ${gone}`
    const p = probe(command, pin(command))
    rmSync(gone)
    assert.match((await runProbe(p, o)).refused!, /gone\.sh/)
  })
  test('a pin in the home folder reads ~ through the home option', async () => {
    writeFileSync(join(dir, 'home.sh'), 'printf home')
    const command = '/bin/sh ~/home.sh'
    const p = probe(command, pin(command, dir))
    assert.deepEqual(Object.keys(p.pins), ['/bin/sh', join(dir, 'home.sh')])
    assert.equal((await runProbe(p, { ...o, home: dir })).out, 'home')
  })
})
