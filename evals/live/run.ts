import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gate, grade, summarize, type Evidence, type Row } from './grade.ts'
import { runCase, type Case } from './session.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: '3' }, jobs: { type: 'string', default: '4' }, out: { type: 'string' }, compare: { type: 'boolean', default: false }, timeout: { type: 'string', default: '480' }, trace: { type: 'string' },
} })

type Report = { commit: string; at: string; runs: number; rows: Row[] }
const readReport = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Report

if (values.compare) {
  const [before, after] = positionals.map(readReport) as [Report, Report]
  const failed = gate(before.rows, after.rows)
  process.stderr.write(`${table(before.rows, after.rows)}\n${failed.length ? `GATE FAILS\n${failed.map(f => `  ${f}`).join('\n')}` : 'gate passes: no case fails in 2 or more of 3 runs where it passed before'}\n`)
  process.exit(failed.length ? 1 : 0)
}

const code = resolve(import.meta.dirname, '../..')
const claude = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
const cases = (JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as Case[]).filter(c => !positionals[0] || c.name.includes(positionals[0]))
const runs = Number(values.runs), timeoutMs = Number(values.timeout) * 1000
const work = cases.flatMap(c => Array.from({ length: runs }, () => c))
const results = new Map<string, Evidence[]>()
let next = 0
await Promise.all(Array.from({ length: Number(values.jobs) }, async () => {
  while (next < work.length) {
    const c = work[next++]!
    const ev = await runCase(c, { code, claude, timeoutMs, ...values.trace && { trace: join(values.trace, `${c.name}-${next}.jsonl`) } })
    results.set(c.name, [...results.get(c.name) ?? [], ev])
    const misses = grade(ev, c.expect)
    process.stderr.write(`${misses.length ? 'FAIL' : 'ok  '}  ${c.name}${misses.map(m => `\n      ${m}`).join('')}\n`)
  }
}))
const rows = cases.map(c => { const evs = results.get(c.name)!; return summarize(c.name, evs, evs.map(ev => grade(ev, c.expect))) })
const report: Report = { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), at: new Date().toISOString(), runs, rows }
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))
process.stderr.write(`\n${table(rows)}\n`)

function table(rows: Row[], after?: Row[]): string {
  const cell = (r: Row | undefined) => r ? `${r.passes}/${r.runs}  ${String(r.tokensIn.median).padStart(7)} (${r.tokensIn.min}-${r.tokensIn.max})  ${r.steps}` : 'missing'
  const head = `${'case'.padEnd(36)}${after ? 'before: pass  tokens in per turn  steps | after' : 'pass  tokens in per turn (min-max)  steps'}`
  return [head, ...rows.map(r => `${r.name.padEnd(36)}${cell(r)}${after ? `  |  ${cell(after.find(a => a.name === r.name))}` : ''}`)].join('\n')
}
