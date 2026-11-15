// The repo's structure rules (ADR 0014). Each rule lists today's debt by name. A new break fails, and so does a
// debt entry that is fixed but still listed, so the lists only shrink. Never add to a debt list: fix the code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.js'], { cwd: root, encoding: 'utf8' }).split('\n')
  .filter(f => f && !/(^|\/)tests\//.test(f) && !f.startsWith('docs/'))
const text = new Map(files.map(f => [f, readFileSync(`${root}/${f}`, 'utf8')]))
// The source without line and block comments, so a rule reads code, not prose about it.
const code = (f: string) => text.get(f)!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
// Shell scripts call core/ too (setup.sh runs node with an import), so they count as users of an export.
const scripts = execFileSync('git', ['ls-files', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map(f => readFileSync(`${root}/${f}`, 'utf8'))
// Import lines do not count: splitting a module adds them to its importers, and the rule must not punish a split.
const lines = (f: string) => text.get(f)!.split('\n').slice(0, -1).filter(l => !l.startsWith('import ')).length
const inDir = (d: string) => files.filter(f => f.startsWith(`${d}/`) && f.endsWith('.ts') && !f.slice(d.length + 1).includes('/'))

const MAX_LINES = 300

const DEBT = {
  // ADR 0001: core/ does no I/O, reads no environment, sets no timers, and imports only core/.
  impureCore: [] as string[],
  // runtime/ and connectors/ never import hub/, plugin/ or a file in the repo root: those wire the layers below them.
  rootImports: [] as string[],
  // A source file over MAX_LINES lines (import lines not counted), with the most it may have. Split it; lower the number as it shrinks.
  longFiles: {
    'hub/router.ts': 665, 'cli/top.ts': 607,
    'runtime/sdk-sessions.ts': 334, 'core/sessions.ts': 323,
  } as Record<string, number>,
  // A core/ or runtime/ file missing from the CONTRIBUTING.md code map.
  unmapped: [] as string[],
  // A core/ export no other file needs: over-exported (drop the export) or dead (only a test uses it: delete both).
  unusedCoreExports: [
    'core/config.ts NOT_SETTINGS', 'core/config.ts toEnv',   // leave with the old env import (compat PR)
  ] as string[],
}

function check(name: string, found: string[], debt: string[]) {
  const added = found.filter(x => !debt.includes(x)), fixed = debt.filter(x => !found.includes(x))
  assert.deepEqual(added, [], `${name}: new breaks. Fix them; never add to the debt list in tests/structure.test.ts`)
  assert.deepEqual(fixed, [], `${name}: fixed, so remove these from the debt list in tests/structure.test.ts`)
}

test('core/ is pure: no I/O, no environment, no timers, and imports only core/ (ADR 0001)', () => {
  const bad = /(from|import\(|require\()\s*['"](node:)?(fs|child_process|net|http|https|os|dgram|tls)(\/promises)?['"]|process\.env|\bset(Timeout|Interval)\(|(from|import\(|require\()\s*['"]\.\.\//
  check('impureCore', inDir('core').filter(f => bad.test(code(f))), DEBT.impureCore)
})

test('runtime/ and connectors/ never import the hub, the plugin or a root file', () => {
  const bad = /(from|import\(|require\()\s*['"]\.\.\/(?:(?:hub|plugin)\/)?[^/'"]+['"]/
  check('rootImports', [...inDir('runtime'), ...inDir('connectors')].filter(f => bad.test(code(f))), DEBT.rootImports)
})

test('the hub and the plugin never import a kage command (cli/)', () => {
  const bad = /(from|import\(|require\()\s*['"]\.\.\/cli\//
  assert.deepEqual([...inDir('hub'), ...inDir('plugin')].filter(f => bad.test(code(f))), [], 'move what both need into runtime/ or core/')
})

test(`a source file is ${MAX_LINES} lines or fewer, imports aside, and a long one never grows`, () => {
  const long = files.filter(f => lines(f) > MAX_LINES)
  check('longFiles', long, Object.keys(DEBT.longFiles))
  const grew = long.filter(f => lines(f) > DEBT.longFiles[f]!).map(f => `${f}: ${lines(f)} > ${DEBT.longFiles[f]}`)
  assert.deepEqual(grew, [], 'longFiles: these grew. Split them instead')
})

test('every core/, runtime/, runtime/tools/, hub/ and plugin/ file is in the CONTRIBUTING.md code map', () => {
  const map = readFileSync(`${root}/CONTRIBUTING.md`, 'utf8')
  check('unmapped', [...inDir('core'), ...inDir('runtime')].filter(f => !map.includes(`\`${basename(f)}\``)), DEBT.unmapped)
  assert.deepEqual([...inDir('hub'), ...inDir('plugin'), ...inDir('runtime/tools')].filter(f => !map.includes(`\`${f}\``)), [], 'add a row for each to the code map')
})

test('a core/ export is used outside its file: by another source file, or by its own file and a test', () => {
  const tests = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*/tests/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const testText = tests.map(f => readFileSync(`${root}/${f}`, 'utf8'))
  const exported = (f: string) => [
    ...[...code(f).matchAll(/^export (?:async )?(?:function\*?|const|let|class|type|interface) (\w+)/gm)].map(m => m[1]!),
    ...[...code(f).matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(m => m[1]!.split(',').map(x => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean)),
  ]
  const unused: string[] = []
  for (const f of inDir('core')) for (const name of exported(f)) {
    const word = new RegExp(`\\b${name}\\b`, 'g')
    const elsewhere = files.some(g => g !== f && word.test(text.get(g)!)) || scripts.some(t => word.test(t))
    const ownUse = (code(f).match(word) ?? []).length > 1
    const tested = testText.some(t => new RegExp(`\\b${name}\\b`).test(t))
    // Fine: another file uses it, or its own file does and a test drives it directly.
    // Over-exported: only its own file uses it (drop the export). Dead: only a test uses it (delete both).
    if (!elsewhere && !(ownUse && tested)) unused.push(`${f} ${name}`)
  }
  check('unusedCoreExports', unused, DEBT.unusedCoreExports)
})

test('code marked "compat: remove after <date>" is gone by that date', () => {
  const today = new Date().toISOString().slice(0, 10)
  const shell = execFileSync('git', ['ls-files', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const f of shell) if (!text.has(f)) text.set(f, readFileSync(`${root}/${f}`, 'utf8'))
  const due = [...files, ...shell].flatMap(f => [...text.get(f)!.matchAll(/compat: remove after (\d{4}-\d{2}-\d{2})/g)].filter(m => m[1]! < today).map(m => `${f} (${m[1]})`))
  assert.deepEqual(due, [], 'past their removal date: delete the compat code')
})

// A child process gets the hub's whole environment only when it is trusted with it: git, the doctor, the owner's own
// call command. Anything that opens outside content (a browser, a fetched page) gets a short allowlist (#207).
const FULL_ENV_CHILDREN = ['hub/router.ts', 'cli/call.ts', 'cli/doctor/context.ts', 'runtime/release.ts']
test('only a trusted child process gets ...process.env', () => {
  const spread = files.filter(f => /\.\.\.process\.env\b/.test(code(f)))
  assert.deepEqual(spread.filter(f => !FULL_ENV_CHILDREN.includes(f)), [], 'give this child an env allowlist, or add it to FULL_ENV_CHILDREN with the reason')
})
