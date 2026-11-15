import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pin, runProbe } from '../probes.ts'

const o = { timeoutMs: 5000, maxBytes: 1024, patternMax: 200 }
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
  test('a missing home folder does not stop the probe: HOME is set to it and the command runs', async () => {
    const r = await runProbe(probe('printf "%s" "$HOME"'), { ...o, home: '/no/such/dir' })
    assert.deepEqual([r.ok, r.out], [true, '/no/such/dir'])
  })
  test('keeps stderr apart from stdout', async () => {
    const r = await runProbe(probe('printf out; printf err >&2'), o)
    assert.deepEqual([r.out, r.err], ['out', 'err'])
  })
})

describe('unsafe ignore patterns', () => {
  test('a probe with a nested-quantifier or invalid ignore is refused and never runs', async () => {
    for (const ignore of ['(a+)+', '(']) {
      const r = await runProbe({ command: 'printf ran', pins: {}, ignore: [ignore] }, o)
      assert.deepEqual([r.ok, r.out], [false, ''])
      assert.match(r.refused!, /^ignore pattern/)
    }
  })
})

describe('probe environment', () => {
  const run = (env?: string[]) => runProbe(probe('printf "%s" "$SSH_AUTH_SOCK"'), { ...o, ...(env && { env }) })
  test('a listed variable reaches the probe, an unlisted one does not, and an unset one is skipped', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    try {
      assert.equal((await run(['PATH', 'SSH_AUTH_SOCK'])).out, '/tmp/agent.sock')
      assert.equal((await run(['PATH'])).out, '')
      assert.equal((await run(['PATH', 'KAGE_NOT_SET_ANYWHERE'])).ok, true)
    } finally { delete process.env.SSH_AUTH_SOCK }
  })
  test('a name not in the setting never reaches the probe', async () => {
    process.env.KAGE_TEST_SECRET = 's3cret'
    try { assert.equal((await runProbe(probe('printf "%s" "$KAGE_TEST_SECRET"'), { ...o, env: ['PATH'] })).out, '') } finally { delete process.env.KAGE_TEST_SECRET }
  })
})

describe('pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'))
  const make = (name: string, body: string, mode = 0o755) => { const f = join(dir, name); writeFileSync(f, body, { mode }); chmodSync(f, mode); return f }
  const script = make('check.sh', 'printf one')

  test('pin hashes a writable script that runs, and skips a missing path', () => {
    const p = pin(`${script}; /no/such/file`, dir)
    assert.deepEqual(Object.keys(p), [script])
    assert.match(p[script]!, /^[0-9a-f]{64}$/)
  })
  test('a data file the probe reads is not pinned, so appending to it still runs', async () => {
    const log = make('app.log', 'one\n')
    const command = `wc -l ${log}`
    const p = probe(command, pin(command, dir))
    assert.deepEqual(p.pins, {})
    const before = await runProbe(p, o)
    appendFileSync(log, 'two\n')
    const after = await runProbe(p, o)
    assert.deepEqual([before.ok, after.ok, after.refused], [true, true, undefined])
    assert.notEqual(before.out, after.out)
  })
  test('a non-writable executable is not pinned', () => {
    const ro = make('ro.sh', 'printf x', 0o555)
    assert.deepEqual(pin(`${ro}`, dir), {})
    assert.deepEqual(pin('/bin/sh -c true', dir), {})
  })
  test('a pinned script runs, then is refused after an edit, with its path named', async () => {
    const p = probe(`${script}`, pin(`${script}`, dir))
    assert.equal((await runProbe(p, o)).out, 'one')
    writeFileSync(script, 'printf two')
    const r = await runProbe(p, o)
    assert.equal(r.ok, false)
    assert.match(r.refused!, new RegExp(script))
    assert.equal(r.out, '')
  })
  test('python3 ./check.py is pinned and refused after an edit', async () => {
    const py = make('check.py', 'print(1)', 0o644)
    const command = `python3 ${py}`
    const p = probe(command, pin(command, dir))
    assert.deepEqual(Object.keys(p.pins), [py])
    assert.equal((await runProbe(p, o)).out.trim(), '1')
    writeFileSync(py, 'print(2)')
    assert.match((await runProbe(p, o)).refused!, /check\.py/)
  })
  test('cd dir && ./run.sh is pinned against dir and refused after an edit', async () => {
    const run = make('run.sh', 'printf ran')
    const command = `cd ${dir} && ./run.sh`
    const p = probe(command, pin(command, dir))
    assert.deepEqual(Object.keys(p.pins), [run])
    assert.equal((await runProbe(p, o)).out, 'ran')
    writeFileSync(run, 'printf changed')
    assert.match((await runProbe(p, o)).refused!, /run\.sh/)
  })
  test('is refused when a pinned file is gone', async () => {
    const gone = make('gone.sh', 'x')
    const p = probe(gone, pin(gone, dir))
    rmSync(gone)
    assert.match((await runProbe(p, o)).refused!, /gone\.sh/)
  })
  test('a pin in the home folder reads ~ through the home option', async () => {
    const h = make('home.sh', 'printf home')
    const command = '~/home.sh'
    const p = probe(command, pin(command, dir))
    assert.deepEqual(Object.keys(p.pins), [h])
    assert.equal((await runProbe(p, { ...o, home: dir })).out, 'home')
  })
})
