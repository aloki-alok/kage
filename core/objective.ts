// A kagelet's objective (ADR 0016): the outcome in plain words, a measure the hub runs with no model, and a target.
// For a worker the number is a scoreboard: every run reads it, and meeting the target never stops the work.
type Op = '<=' | '>=' | '<' | '>' | '=='
export type Target = { op: Op; n: number }
export type Objective = { objective: string; measure: string; target: Target }
// One measure: its value, or why it failed. A failed measure is never a guessed number.
export type Reading = { at: number; value?: number; failed?: string }

const TARGET = /^(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)$/
const VALUE = /^value: (-?\d+(?:\.\d+)?)$/

// From a kagelet file's front matter: all three lines, or none.
export function objectiveOf(head: Map<string, string>): Objective | { error: string } | undefined {
  const [objective, measure, target] = ['objective', 'measure', 'target'].map(k => head.get(k)?.trim() ?? '')
  if (!objective && !measure && !target) return undefined
  if (!objective || !measure || !target) return { error: 'an objective needs all three lines: objective, measure and target' }
  const t = TARGET.exec(target)
  if (!t) return { error: `target must be a comparison like "<= 2" or ">= 500", not "${target}"` }
  return { objective, measure, target: { op: t[1] as Op, n: Number(t[2]) } }
}

// The measure's output must be exactly one line, value: <n>.
export function readValue(out: string): number | undefined {
  const lines = out.trim().split('\n')
  const m = lines.length === 1 ? VALUE.exec(lines[0]!) : null
  return m ? Number(m[1]) : undefined
}

export function meets(value: number, t: Target): boolean {
  return t.op === '<=' ? value <= t.n : t.op === '>=' ? value >= t.n : t.op === '<' ? value < t.n : t.op === '>' ? value > t.n : value === t.n
}

// What every run reads above its job: the number against the target, and the trend of the last readings.
export function scoreboard(o: Objective, readings: Reading[]): string {
  const values = readings.filter(r => r.value !== undefined).map(r => r.value!)
  const last = readings.at(-1)
  const now = values.length ? `${values.at(-1)} (target ${o.target.op} ${o.target.n}, ${meets(values.at(-1)!, o.target) ? 'met' : 'not met'})` : 'not measured yet'
  return [`Objective: ${o.objective}`, `Number: ${now}${values.length > 1 ? `. Trend, oldest first: ${values.join(', ')}` : ''}`,
    ...last?.failed ? [`The last measure failed (${last.failed}): say so in your report, and do not guess the number.`] : [],
    'Keep working toward it, met or not, and end your report with the number you saw.'].join('\n')
}
