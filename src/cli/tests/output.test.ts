import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const run = (code: string, ...args: string[]) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { outputFlags, printJson } from ${JSON.stringify(new URL('../output.ts', import.meta.url).pathname)}; ${code}`, '--', ...args], { encoding: 'utf8' })

test('--json prints the rows as JSON on stdout, and the other words stay as arguments', () => {
  const r = run('const o = outputFlags(process.argv.slice(1)); if (o.json) printJson([{ id: "a", n: 1 }], o.jq); else console.log(o.args.join(","))', '7', '--json')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), [{ id: 'a', n: 1 }])
  assert.equal(run('console.log(outputFlags(process.argv.slice(1)).args.join(","))', '7', 'x').stdout.trim(), '7,x')
})
test('--jq filters the JSON with jq, and implies --json', () => {
  const r = run('const o = outputFlags(process.argv.slice(1)); if (o.json) printJson([{ id: "a" }, { id: "b" }], o.jq)', '--jq', '.[].id')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '"a"\n"b"\n')
})
test('a bad jq filter, or --jq with no filter, is bad usage: exit 2', () => {
  assert.equal(run('const o = outputFlags(process.argv.slice(1)); printJson([1], o.jq)', '--jq', '.[').status, 2)
  const bare = run('outputFlags(process.argv.slice(1))', '--jq')
  assert.equal(bare.status, 2)
  assert.match(bare.stderr, /--jq takes a filter/)
})
