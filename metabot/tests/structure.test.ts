// The absolute rule, as a test: a Meta bot never runs a command. Nothing the bot loads, its own files and every core/
// file they reach, may import a way to start a process or run code, or any part of Kage that can (hub, runtime,
// connectors, cli, plugin).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const root = normalize(join(import.meta.dirname, '..', '..'))
const ALLOWED_NODE = new Set(['node:fs', 'node:http', 'node:os', 'node:path', 'node:url', 'node:sqlite', 'node:crypto'])
const FORBIDDEN_CALLS = /child_process|worker_threads|node:vm|node:cluster|\beval\s*\(|new\s+Function\s*\(|process\.binding|\.spawn\s*\(|\bexecSync\s*\(|execFile/
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
// import ... from 'x', export ... from 'x', a bare import 'x', and import('x').
const importsOf = (f: string) => [...code(f).matchAll(/(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')

function reach(): string[] {
  const start = readdirSync(join(root, 'metabot')).filter(f => f.endsWith('.ts')).map(f => join(root, 'metabot', f))
  const seen = new Set<string>(), todo = [...start]
  while (todo.length) {
    const f = todo.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const spec of importsOf(f)) if (spec.startsWith('.')) todo.push(normalize(join(dirname(f), spec)))
  }
  return [...seen]
}

test('everything the bot loads stays inside metabot/ and core/, with only safe node modules', () => {
  const bad: string[] = []
  for (const f of reach()) {
    const rel = relative(root, f)
    if (!/^(metabot|core)\/[^/]+\.ts$/.test(rel)) bad.push(`${rel} is loaded`)
    for (const spec of importsOf(f)) {
      if (spec.startsWith('.')) continue
      if (spec.startsWith('node:') ? !ALLOWED_NODE.has(spec) : true) bad.push(`${rel} imports ${spec}`)
    }
    if (FORBIDDEN_CALLS.test(code(f))) bad.push(`${rel} names a way to run a process or code`)
  }
  assert.deepEqual(bad, [])
})

test('the rule bites: a planted import of a process module is found', () => {
  assert.ok(FORBIDDEN_CALLS.test("import { spawn } from 'node:child_process'"))
  assert.ok(FORBIDDEN_CALLS.test('cp.execSync("rm -rf /")'))
  assert.equal(ALLOWED_NODE.has('node:child_process'), false)
  const planted = (src: string) => [...src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1])
  assert.deepEqual(planted("x\nimport '../runtime/log.ts'\n"), ['../runtime/log.ts'])
})
