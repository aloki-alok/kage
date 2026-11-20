process.env.TZ = 'UTC'
const { readdirSync, readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const { scenario } = await import('./harness.ts')
const { score } = await import('./score.ts')
const { scoreDream } = await import('./dream/score.ts')
type Scenario = import('./score.ts').Scenario
type DreamCase = import('./dream/score.ts').DreamCase

const only = process.argv[2]
let failed = 0
const report = (name: string, misses: string[]) => {
  if (misses.length) failed++
  process.stderr.write(`${misses.length ? 'FAIL' : 'ok  '}  ${name}\n${misses.map(m => `      ${m}\n`).join('')}`)
}

const dir = join(import.meta.dirname, 'scenarios')
for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && (!only || f.includes(only))).sort()) {
  const s = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario
  let misses: string[]
  try { misses = score(await scenario(s.steps), s.expect) } catch (e) { misses = [`crashed: ${(e as Error).message}`] }
  report(s.name, misses)
}
const cases = JSON.parse(readFileSync(join(import.meta.dirname, 'dream', 'cases.json'), 'utf8')) as DreamCase[]
for (const c of cases.filter(c => !only || c.name.includes(only))) report(`dream: ${c.name}`, scoreDream(c))

process.stderr.write(failed ? `${failed} eval${failed === 1 ? '' : 's'} failed\n` : 'every eval passed\n')
process.exit(failed ? 1 : 0)
