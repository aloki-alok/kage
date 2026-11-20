type Op = '<=' | '>=' | '<' | '>' | '=='
export type Target = { op: Op; n: number }
export type Objective = { objective: string; measure: string; target: Target }
export type Reading = { at: number; value?: number; failed?: string }

const TARGET = /^(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)$/
const VALUE = /^value: (-?\d+(?:\.\d+)?)$/

export function objectiveOf(head: Map<string, string>): Objective | { error: string } | undefined {
  const [objective, measure, target] = ['objective', 'measure', 'target'].map(k => head.get(k)?.trim() ?? '')
  if (!objective && !measure && !target) return undefined
  if (!objective || !measure || !target) return { error: 'an objective needs all three lines: objective, measure and target' }
  const t = TARGET.exec(target)
  if (!t) return { error: `target must be a comparison like "<= 2" or ">= 500", not "${target}"` }
  return { objective, measure, target: { op: t[1] as Op, n: Number(t[2]) } }
}

export function readValue(out: string): number | undefined {
  const lines = out.trim().split('\n')
  const m = lines.length === 1 ? VALUE.exec(lines[0]!) : null
  return m ? Number(m[1]) : undefined
}

export function meets(value: number, t: Target): boolean {
  return t.op === '<=' ? value <= t.n : t.op === '>=' ? value >= t.n : t.op === '<' ? value < t.n : t.op === '>' ? value > t.n : value === t.n
}

function moved(before: number, after: number, t: Target): string {
  if (after === before) return `no change (${after})`
  const better = t.op === '>=' || t.op === '>' ? after > before : t.op === '<=' || t.op === '<' ? after < before : Math.abs(after - t.n) < Math.abs(before - t.n)
  return `${before} to ${after}, ${after > before ? 'up' : 'down'} ${+Math.abs(after - before).toFixed(6)}, ${better ? 'toward' : 'away from'} the target`
}

export function scoreboard(o: Objective, readings: Reading[]): string {
  const values = readings.filter(r => r.value !== undefined).map(r => r.value!)
  const last = readings.at(-1)
  const now = values.length ? `${values.at(-1)} (target ${o.target.op} ${o.target.n}, ${meets(values.at(-1)!, o.target) ? 'met' : 'not met'})` : 'not measured yet'
  const [before, after] = last?.value !== undefined && readings.at(-2)?.value !== undefined ? [readings.at(-2)!.value!, last.value] : []
  return [`Objective: ${o.objective}`, `Number: ${now}${values.length > 1 ? `. Trend, oldest first: ${values.join(', ')}` : ''}`,
    ...before !== undefined ? [`Since the last measure: ${moved(before, after!, o.target)}.`] : [],
    ...last?.failed ? [`The last measure failed (${last.failed}): say so in your report, and do not guess the number.`] : [],
    'Keep working toward it, met or not. End your report with how the number moved since the last measure and your next step. If it did not move the way your last run expected, change this run\'s plan.'].join('\n')
}
