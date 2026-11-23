import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.js'], { cwd: root, encoding: 'utf8' }).split('\n')
  .filter(f => f && !/(^|\/)tests\//.test(f) && !f.startsWith('docs/'))
const text = new Map(files.map(f => [f, readFileSync(`${root}/${f}`, 'utf8')]))
const code = (f: string) => text.get(f)!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
const scripts = execFileSync('git', ['ls-files', '*.sh', 'tests/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !f.endsWith('.test.ts')).map(f => readFileSync(`${root}/${f}`, 'utf8'))
const lines = (f: string) => text.get(f)!.split('\n').slice(0, -1).filter(l => !l.startsWith('import ')).length
const inDir = (d: string) => files.filter(f => f.startsWith(`${d}/`) && f.endsWith('.ts') && !f.slice(d.length + 1).includes('/'))
const under = (d: string) => files.filter(f => f.startsWith(`${d}/`) && f.endsWith('.ts') && !f.includes('/tests/'))
const importsOf = (f: string) => [...code(f).matchAll(/(?:\bfrom|^import|\bimport\(|\brequire\()\s*['"](\.[^'"]*)['"]/gm)].map(m => posix.join(posix.dirname(f), m[1]!))

const MAX_LINES = 300
const EXPORT_LAYERS = ['src/core', 'src/runtime', 'src/connectors', 'src/hub', 'src/cli', 'plugin', 'metabot', 'meetbot', 'evals']

const DEBT = {
  commented: [] as string[],
  impureCore: [] as string[],
  rootImports: [] as string[],
  longFiles: {
    'src/hub/router.ts': 347, 'src/cli/top.ts': 331,
  } as Record<string, number>,
  unmapped: [] as string[],
  unusedExports: [] as string[],
}

function check(name: string, found: string[], debt: string[]) {
  const added = found.filter(x => !debt.includes(x)), fixed = debt.filter(x => !found.includes(x))
  assert.deepEqual(added, [], `${name}: new breaks. Fix them; never add to the debt list in tests/structure.test.ts`)
  assert.deepEqual(fixed, [], `${name}: fixed, so remove these from the debt list in tests/structure.test.ts`)
}

test('core/ is pure: no I/O, no environment, no timers, and imports only core/ (ADR 0001)', () => {
  const io = /(from|import\(|require\()\s*['"](node:)?(fs|child_process|net|http|https|os|dgram|tls)(\/promises)?['"]|process\.env|\bset(Timeout|Interval)\(/
  check('impureCore', under('src/core').filter(f => io.test(code(f)) || importsOf(f).some(p => !p.startsWith('src/core/'))), DEBT.impureCore)
})

test('runtime/ and connectors/ never import the hub, the plugin or a root file', () => {
  const above = (p: string) => p.startsWith('src/hub/') || p.startsWith('plugin/') || !p.includes('/')
  check('rootImports', [...under('src/runtime'), ...under('src/connectors')].filter(f => importsOf(f).some(above)), DEBT.rootImports)
})

test('a connector listens only through listen() in connectors/webhook.ts, so a taken port cannot crash the hub', () => {
  assert.deepEqual(under('src/connectors').filter(f => f !== 'src/connectors/webhook.ts' && /\bcreateServer\(/.test(code(f))), [])
})

test('only core/ builds a Task, so who counts as the owner is decided in one place (ADR 0002, #273)', () => {
  const built = files.filter(f => !f.startsWith('src/core/') && f.endsWith('.ts') && /type:\s*['"`]task['"`]|\bas Task\b|fromOwner:\s*true/.test(code(f)))
  assert.deepEqual(built, [], 'build it with taskAsOwner(), taskAsOther() or taskFrom() from core/gate.ts')
})

test("a tool asks ownerNow() whether this is the owner's turn, never the per-task map, so a mid-turn message cannot lift a turn's trust (#364)", () => {
  assert.deepEqual(files.filter(f => f !== 'src/runtime/kage-tools.ts' && /\bownerTask\.get\(/.test(code(f))), [])
})

test('the hub and the plugin never import a kage command (cli/)', () => {
  assert.deepEqual([...inDir('src/hub'), ...inDir('plugin')].filter(f => importsOf(f).some(p => p.startsWith('src/cli/'))), [], 'move what both need into src/runtime/ or src/core/')
})

test(`a source file is ${MAX_LINES} lines or fewer, imports aside, and a long one never grows`, () => {
  const long = files.filter(f => lines(f) > MAX_LINES)
  check('longFiles', long, Object.keys(DEBT.longFiles))
  const grew = long.filter(f => lines(f) > DEBT.longFiles[f]!).map(f => `${f}: ${lines(f)} > ${DEBT.longFiles[f]}`)
  assert.deepEqual(grew, [], 'longFiles: these grew. Split them instead')
})

test('every core/, runtime/, runtime/tools/, hub/ and plugin/ file is in the CONTRIBUTING.md code map', () => {
  const map = readFileSync(`${root}/CONTRIBUTING.md`, 'utf8')
  const inLayer = (f: string) => f.split('/').slice(2).join('/')
  check('unmapped', [...under('src/core'), ...under('src/runtime').filter(f => !f.startsWith('src/runtime/tools/'))].filter(f => !map.includes(`\`${inLayer(f)}\``)), DEBT.unmapped)
  assert.deepEqual([...inDir('src/hub'), ...inDir('plugin'), ...inDir('src/runtime/tools')].filter(f => !map.includes(`\`${f}\``)), [], 'add a row for each to the code map')
})

test('an export is used outside its file: by another source file, or by its own file and a test', () => {
  const tests = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*/tests/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const testText = tests.map(f => readFileSync(`${root}/${f}`, 'utf8'))
  const exported = (f: string) => [
    ...[...code(f).matchAll(/^export (?:async )?(?:function\*?|const|let|class|type|interface) (\w+)/gm)].map(m => m[1]!),
    ...[...code(f).matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(m => m[1]!.split(',').map(x => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean)),
  ]
  const unused: string[] = []
  for (const f of EXPORT_LAYERS.flatMap(under)) for (const name of exported(f)) {
    const word = new RegExp(`\\b${name}\\b`, 'g')
    const elsewhere = files.some(g => g !== f && word.test(text.get(g)!)) || scripts.some(t => word.test(t))
    const ownUse = (code(f).match(word) ?? []).length > 1
    const tested = testText.some(t => new RegExp(`\\b${name}\\b`).test(t))
    if (!elsewhere && !(ownUse && tested)) unused.push(`${f} ${name}`)
  }
  check('unusedExports', unused, DEBT.unusedExports)
})

test('a .ts file has no comments: names say what code does, and the why lives in the commit and the ADRs', () => {
  const all = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !f.startsWith('docs/'))
  const comment = /^\s*(\/\/|\/\*|\*)|  \/\/ /
  const kept = /compat: remove after|@ts-/
  const commented = all.filter(f => readFileSync(`${root}/${f}`, 'utf8').split('\n').some(l => comment.test(l) && !kept.test(l)))
  check('commented', [...new Set(commented.map(f => f.includes('/') ? `${f.split('/')[0]}/` : f))], DEBT.commented)
})

test('code marked "compat: remove after <date>" is gone by that date', () => {
  const today = new Date().toISOString().slice(0, 10)
  const shell = execFileSync('git', ['ls-files', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const f of shell) if (!text.has(f)) text.set(f, readFileSync(`${root}/${f}`, 'utf8'))
  const due = [...files, ...shell].flatMap(f => [...text.get(f)!.matchAll(/compat: remove after (\d{4}-\d{2}-\d{2})/g)].filter(m => m[1]! < today).map(m => `${f} (${m[1]})`))
  assert.deepEqual(due, [], 'past their removal date: delete the compat code')
})

const FULL_ENV_CHILDREN = ['src/hub/router.ts', 'src/cli/call.ts', 'src/cli/doctor/context.ts', 'src/runtime/release.ts']
test('only a trusted child process gets ...process.env', () => {
  const spread = files.filter(f => /\.\.\.process\.env\b/.test(code(f)))
  assert.deepEqual(spread.filter(f => !FULL_ENV_CHILDREN.includes(f)), [], 'give this child an env allowlist, or add it to FULL_ENV_CHILDREN with the reason')
})

test('a fixed line to the owner comes from core/messages.ts, never a string written at the call (#241)', () => {
  const literal = /\b(notifyOwner|owner\.say|o\.(notify|notifyOwner|tell|tellOwner|say))\(\s*['"`]/
  assert.deepEqual([...under('src/hub'), ...under('src/runtime'), ...under('src/connectors')].filter(f => literal.test(code(f))), [])
})
