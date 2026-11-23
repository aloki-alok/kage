import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../long-output.sh', import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), 'kage-long-output-'))
const NOTE = /\n\[More output follows\. It is saved live to \S+, and its end prints when the command finishes\.\]\n/
const CUT = /\[(\d+) characters cut from the middle\. The full output is in (\S+)\]\n/

function run(text: string, exit = 0) {
  const data = join(work, `case-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(data, text)
  const r = spawnSync(script, [`: snapshot-bash-test; cat '${data}'; exit ${exit}`], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
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
  const r = spawnSync(script, [': snapshot-bash-test; seq 1 100; sleep 0.3; echo LATER'], { encoding: 'utf8', env: { ...process.env, TMPDIR: work, KAGE_OUTPUT_CHARS: '25' } })
  assert.match(r.stdout, NOTE)
  assert.ok(r.stdout.endsWith('LATER\n'))
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
