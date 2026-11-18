import { spawn } from 'node:child_process'
import { globSync } from 'node:fs'
import { availableParallelism } from 'node:os'

const args = process.argv.slice(2)
const limit = Number(args.find(a => a.startsWith('--limit='))?.slice(8) ?? 300) * 1000
const files = [...new Set(args.filter(a => !a.startsWith('--')).flatMap(g => globSync(g)))].sort()
if (!files.length) { console.error('no test files match'); process.exit(1) }

type Result = { file: string; code: number | null; ms: number; out: string; killed: boolean }
const runOne = (file: string) => new Promise<Result>(done => {
  const start = Date.now()
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const child = spawn(process.execPath, ['--test', `--test-timeout=${limit}`, file], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  let killed = false
  const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, limit)
  child.on('close', code => { clearTimeout(timer); done({ file, code, ms: Date.now() - start, out, killed }) })
})

const queue = [...files]
const failed: Result[] = []
let pass = 0
const worker = async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const r = await runOne(f)
    if (r.code === 0 && !r.killed) { pass++; console.log(`ok    ${r.file} (${(r.ms / 1000).toFixed(1)} s)`); continue }
    failed.push(r)
    console.log(r.killed ? `KILL  ${r.file}: still running after ${limit / 1000} s` : `FAIL  ${r.file}`)
    if (!r.killed) console.log(r.out)
  }
}
await Promise.all(Array.from({ length: Math.max(1, availableParallelism() - 1) }, worker))
console.log(`\n${pass} files passed, ${failed.length} failed${failed.length ? `: ${failed.map(r => r.file).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
