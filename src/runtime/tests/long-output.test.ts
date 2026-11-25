import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../long-output.sh', import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), 'kage-long-output-'))
const NOTE = /\n\[More output follows\. It is saved live to (\S+), and its end prints when the command finishes\.\]\n/
const CUT = /\n\[(\d+) bytes cut from the middle\. The full output is in (\S+)\]\n/

function run(text: string, exit = 0) {
  const data = join(work, `case-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(data, text)
  const r = spawnSync(script, [`: snapshot-bash-test; eval 'cat ${data}; exit ${exit}' < /dev/null && pwd -P >| /dev/null`], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  return { out: r.stdout.replace(NOTE, ''), code: r.status }
}

test('output that fits the head and tail passes through unchanged, with its exit code', () => {
  for (const text of ['', 'one line', 'a\nb\n', 'x'.repeat(30), 'y'.repeat(26), 'z'.repeat(50)]) {
    const r = run(text, 3)
    assert.equal(r.out, text, `${text.length} characters`)
    assert.equal(r.code, 3)
  }
})

test('long output keeps its start and its end, so the error a failed command prints last still shows', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\nFAIL: the last line\n'
  const r = run(text, 1)
  const cut = CUT.exec(r.out)
  assert.ok(cut, 'a line says what was cut and where the full output is')
  assert.equal(r.out.slice(0, cut.index), text.slice(0, 25))
  assert.equal(r.out.slice(cut.index + cut[0].length), text.slice(-25))
  assert.ok(r.out.endsWith('FAIL: the last line\n'))
  assert.equal(Number(cut[1]), text.length - 50)
  assert.equal(readFileSync(cut[2]!, 'utf8'), text, 'the saved file holds every character')
  assert.equal(r.code, 1)
})

test('output that keeps coming after the head says where its live copy is', () => {
  const r = spawnSync(script, [": snapshot-bash-test; eval 'seq 1 100; sleep 0.3; echo LATER' < /dev/null && pwd -P >| /dev/null"], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  assert.match(r.stdout, NOTE)
  assert.ok(r.stdout.endsWith('LATER\n'))
})

test('the first part streams as the command prints it, not when it ends', async () => {
  const child = spawn(script, [": snapshot-bash-test; eval 'echo first; sleep 3; echo second' < /dev/null && pwd -P >| /dev/null"], { env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  let seen = ''
  child.stdout.on('data', d => { seen += d })
  await new Promise(r => setTimeout(r, 1500))
  assert.equal(seen, 'first\n')
  await new Promise(r => child.on('close', r))
  assert.equal(seen, 'first\nsecond\n')
})

test('a note about the live copy always names a file that still exists', () => {
  const r = spawnSync(script, [": snapshot-bash-test; eval 'printf %030d 1; sleep 0.3; printf %010d 2' < /dev/null && pwd -P >| /dev/null"], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  const note = NOTE.exec(r.stdout)
  assert.ok(note)
  assert.ok(existsSync(note[1]!))
  assert.equal(r.stdout.replace(NOTE, ''), '0'.repeat(29) + '1' + '0'.repeat(9) + '2')
})

test('an MCP server or a hook that Claude Code starts through the same prefix runs untouched, its stdin and stdout streaming both ways', () => {
  const r = spawnSync(script, ['cat; seq 1 5000'], { input: 'a request from Claude Code\n', encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  assert.equal(r.stdout, 'a request from Claude Code\n' + Array.from({ length: 5000 }, (_, i) => `${i + 1}\n`).join(''))
  assert.equal(r.status, 0)
})

test('a single line longer than the head is cut by characters, not dropped', () => {
  const text = 'a'.repeat(5000) + '\nEND\n'
  const r = run(text)
  const cut = CUT.exec(r.out)!
  assert.equal(r.out.slice(0, cut.index), 'a'.repeat(25))
  assert.equal(r.out.slice(cut.index + cut[0].length), text.slice(-25))
})

test('random output sizes keep the exact contract', () => {
  let seed = 7
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
  for (let i = 0; i < 60; i++) {
    const text = Array.from({ length: rand(12) }, () => 'abc 123'.repeat(rand(9))).join('\n') + (rand(2) ? '\n' : '')
    const code = [0, 1, 2, 127][rand(4)]!
    const r = run(text, code)
    assert.equal(r.code, code)
    const cut = CUT.exec(r.out)
    if (text.length <= 50) assert.equal(r.out, text)
    else assert.equal(r.out.slice(0, cut!.index) + r.out.slice(cut!.index + cut![0].length), text.slice(0, 25) + text.slice(-25))
  }
})

test('a snapshot that resets PATH cannot hide the relay stand-in: KAGE_SSM_SHIM goes back to the front before the command runs', () => {
  const shim = mkdtempSync(join(tmpdir(), 'kage-shim-'))
  writeFileSync(join(shim, 'session-manager-plugin'), '#!/bin/sh\n')
  chmodSync(join(shim, 'session-manager-plugin'), 0o755)
  const cmd = `source /dev/null && export PATH=/usr/bin:/bin && eval 'command -v session-manager-plugin; echo $PATH | cut -d: -f1' < /dev/null && pwd -P >| /dev/null`
  const r = spawnSync(script, [cmd], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_SSM_SHIM: shim } })
  assert.equal(r.stdout, `${shim}/session-manager-plugin\n${shim}\n`)
  const plain = spawnSync(script, [cmd], { encoding: 'utf8', env: { ...process.env, TMPDIR: work } })
  assert.equal(plain.stdout, '/usr/bin\n')
})
