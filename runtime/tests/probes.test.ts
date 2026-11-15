import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, appendFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lineHasher } from '../../core/tripwire.ts'
import { pin, runProbe } from '../probes.ts'

const fingerprintOf = (text: string, ignore: string[]) => { const h = lineHasher(ignore, 2000); h.push(text); return h.end() }

const o = { timeoutMs: 5000, maxBytes: 1024, patternMax: 200, lineMax: 2000 }
const probe = (command: string, pins: Record<string, string> = {}) => ({ command, pins, ignore: [], reads: [], writes: [] })

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
  test('a change past the output cap still changes the fingerprint, and the run says it was cut', async () => {
    const run = (tail: string) => runProbe(probe(`head -c 5000 /dev/zero | tr '\\0' a; printf ${tail}`), { ...o, maxBytes: 100 })
    const [x, y] = [await run('x'), await run('y')]
    assert.deepEqual([x.truncated, x.out.length < 200], [true, true])
    assert.notEqual(x.fp, y.fp)
  })
  test('the fingerprint is taken after ignore, over all output', async () => {
    const r = await runProbe({ ...probe('printf "a\\nts=1\\n"'), ignore: ['^ts='] }, o)
    assert.equal(r.fp, fingerprintOf('a', ['^ts=']))
  })
  test('keeps stderr apart from stdout', async () => {
    const r = await runProbe(probe('printf out; printf err >&2'), o)
    assert.deepEqual([r.out, r.err], ['out', 'err'])
  })
})

describe('unsafe ignore patterns', () => {
  test('a probe with a nested-quantifier or invalid ignore is refused and never runs', async () => {
    for (const ignore of ['(a+)+', '(']) {
      const r = await runProbe({ command: 'printf ran', pins: {}, ignore: [ignore], reads: [], writes: [] }, o)
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
  const other = mkdtempSync(join(tmpdir(), 'probe-cwd-'))
  const make = (name: string, body: string, mode = 0o755) => { const f = join(dir, name); writeFileSync(f, body, { mode }); chmodSync(f, mode); return f }
  const pinIn = (command: string, reads: string[] = [], cwd = other, writes: string[] = []) => pin(command, { home: dir, cwd, reads, writes })
  const refusedAfterEdit = async (command: string, file: string, cwd = other) => {
    const p = probe(command, pinIn(command, [], cwd))
    assert.ok(file in p.pins, `${command} did not pin ${file}`)
    writeFileSync(file, 'changed ' + Math.random())
    const r = await runProbe(p, o)
    assert.match(r.refused ?? '', new RegExp(file), command)
  }

  test('every shape of command that runs a script pins it, and an edit is refused', async () => {
    let n = 0
    for (const shape of ['env ./x', 'xargs ./x', '. ./x', 'source ./x', 'nohup ./x', 'time ./x', 'if ./x; then true; fi', '$(./x)', '`./x`', '$HOME/x', '(cd DIR; ./x)',
      'sh -c "cd DIR && ./x"', 'cd ~; ./x', 'cd DIR && ./x', 'node --require ./h x', 'python -W ignore x', 'python3 x', 'X=1 ./x', 'DIR/x']) {
      const file = make(`x`, 'printf one')
      make('h', 'printf h')
      await refusedAfterEdit(shape.replaceAll('DIR', dir), file, shape.includes('cd ') ? other : dir)
      n++
    }
    assert.equal(n, 19)
  })
  test('an option file and the script both pin: node --require ./h x', () => {
    make('x', 'x'); make('h', 'h')
    const pins = pinIn(`cd ${dir}; node --require ./h x`)
    assert.ok(join(dir, 'h') in pins && join(dir, 'x') in pins)
  })
  test('a file in reads is not pinned, so it changing still runs and changes the fingerprint', async () => {
    const log = make('app.log', 'one\n')
    const command = `wc -l ${log}`
    const p = probe(command, pinIn(command, [log]))
    assert.deepEqual(p.pins, {})
    const before = await runProbe(p, o)
    appendFileSync(log, 'two\n')
    const after = await runProbe(p, o)
    assert.deepEqual([before.ok, after.ok, after.refused], [true, true, undefined])
    assert.notEqual(before.fp, after.fp)
  })
  test('the same data file not listed in reads is pinned, so it changing is refused', async () => {
    const log = make('other.log', 'one\n')
    await refusedAfterEdit(`wc -l ${log}`, log)
  })
  test('a system binary in a folder the user cannot write is not pinned', () => {
    assert.deepEqual(pinIn('/bin/sh -c true'), {})
    assert.deepEqual(pinIn('/usr/bin/env true'), {})
  })
  test('a file the user cannot write is pinned when its folder is writable', () => {
    const ro = make('ro.sh', 'printf x', 0o555)
    assert.deepEqual(Object.keys(pinIn(ro)), [ro])
  })
  test('a symlink in a writable folder to a locked file is pinned, and repointing it is refused', async () => {
    const locked = join(mkdtempSync(join(tmpdir(), 'probe-lock-')), 'real.sh')
    writeFileSync(locked, 'printf real', { mode: 0o555 })
    const alt = make('alt.sh', 'printf alt')
    const link = join(dir, 'link.sh')
    symlinkSync(locked, link)
    chmodSync(join(locked, '..'), 0o555)
    const p = probe(link, pinIn(link))
    assert.ok(link in p.pins)
    rmSync(link); symlinkSync(alt, link)
    assert.match((await runProbe(p, o)).refused!, /link\.sh/)
    chmodSync(join(locked, '..'), 0o755)
  })
  test('a path to a missing file in a writable folder is pinned as absent, and refused once it appears', async () => {
    const late = join(dir, 'late.sh')
    const p = probe(late, pinIn(late))
    assert.ok(late in p.pins)
    assert.equal((await runProbe(p, o)).refused, undefined)
    writeFileSync(late, 'printf late')
    assert.match((await runProbe(p, o)).refused!, /late\.sh/)
  })
  test('a missing file in a folder the user cannot write is not pinned', () => {
    assert.deepEqual(pinIn('/no/such/file'), {})
  })
  test('a probe that writes its own output does not refuse itself on the next run', async () => {
    let n = 0
    for (const shape of ['printf x > F', 'printf x >> F', 'printf x 2> F', 'printf x &> F', 'printf x | tee F', 'printf x | tee -a F']) {
      const f = join(dir, `out${n++}.json`)
      const command = shape.replace('F', f)
      const p = probe(command, pinIn(command))
      assert.deepEqual(p.pins, {}, command)
      assert.equal((await runProbe(p, o)).refused, undefined, command)
      assert.equal((await runProbe(p, o)).refused, undefined, command)
    }
  })
  test('a file the probe writes by an option goes in writes, and then is not pinned', async () => {
    const f = join(dir, 'made.txt')
    const command = `touch ${f}`
    assert.ok(f in pinIn(command))
    const p = probe(command, pinIn(command, [], other, [f]))
    assert.deepEqual(p.pins, {})
    assert.equal((await runProbe(p, o)).refused, undefined)
    assert.equal((await runProbe(p, o)).refused, undefined)
  })
  test('is refused when a pinned file is gone', async () => {
    const gone = make('gone.sh', 'x')
    const p = probe(gone, pinIn(gone))
    rmSync(gone)
    assert.match((await runProbe(p, o)).refused!, /gone\.sh/)
  })
  test('a pin in the home folder reads ~ through the home option', async () => {
    const h = make('home.sh', 'printf home')
    const p = probe('~/home.sh', pinIn('~/home.sh'))
    assert.ok(h in p.pins)
    assert.equal((await runProbe(p, { ...o, home: dir })).out, 'home')
  })
  mkdirSync(join(dir, 'sub'))
  test('a folder word is not pinned', () => {
    assert.deepEqual(pinIn(`ls ${join(dir, 'sub')}`), {})
  })
})
