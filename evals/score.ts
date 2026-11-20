import type { Evidence, Step } from './harness.ts'

export type Expect = { tasks?: { key: string; match: string }[]; dms?: string[]; calls?: string[]; cuts?: string[] }
export type Scenario = { name: string; why: string; steps: Step[]; expect: Expect }

const list = <T>(label: string, got: T[], want: unknown[] | undefined, ok: (g: T, w: never) => boolean, show: (g: T) => string): string[] => {
  if (!want) return []
  const out = got.length === want.length ? [] : [`${label}: ${got.length} seen, ${want.length} expected (${got.map(show).join(' | ') || 'none'})`]
  want.forEach((w, i) => { const g = got[i]; if (g !== undefined && !ok(g, w as never)) out.push(`${label} ${i + 1}: ${show(g)} does not match ${JSON.stringify(w)}`) })
  return out
}
const firstLines = (t: string) => t.split('\n').slice(0, 2).join(' / ')

export function score(ev: Evidence, expect: Expect): string[] {
  return [
    ...list('task', ev.tasks, expect.tasks, (g, w: { key: string; match: string }) => g.key === w.key && new RegExp(w.match).test(g.text), g => `${g.key}: ${firstLines(g.text)}`),
    ...list('dm', ev.dms, expect.dms, (g, w: string) => new RegExp(w).test(g), g => firstLines(g)),
    ...list('call', ev.calls, expect.calls, (g, w: string) => new RegExp(w).test(g), g => g),
    ...list('cut', ev.cuts, expect.cuts, (g, w: string) => g === w, g => g),
  ]
}
