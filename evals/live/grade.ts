export type Turn = { tokensIn: number; steps: number }
export type Evidence = {
  replies: string[]; tools: string[]; cards: { tool: string; allowed: boolean }[]; settings: { key: string; value: unknown }[]
  jobs: { cron: string; prompt: string }[]; files: Record<string, string | null>; commands: Record<string, number>
  turns: Turn[]; fixture?: Record<string, string>; error?: string; infra?: string; model?: string
}
type FileCheck = { path: string; match?: string; absent?: string; same?: true }
export type Expect = {
  reply?: string[]; noReply?: string[]; used?: string[]; unused?: string[]
  cards?: number; settings?: number; setting?: string; jobs?: number; jobCron?: string
  files?: FileCheck[]; commands?: string[]
}
export type Generated = { repeat: string; times: number; at?: Record<string, string> }
export type Row = { name: string; passes: number; runs: number; infra: number; tokensIn: { median: number; min: number; max: number }; steps: number; misses: string[][] }

const re = (s: string) => new RegExp(s, 'i')
const count = (label: string, seen: number, want: number | undefined) => want === undefined || seen === want ? [] : [`${label}: ${seen} seen, ${want} expected`]

function fileMisses(ev: Evidence, f: FileCheck): string[] {
  const text = ev.files[f.path]
  if (text === null || text === undefined) return [`${f.path} is missing`]
  return [
    ...f.match && !re(f.match).test(text) ? [`${f.path} lacks /${f.match}/`] : [],
    ...f.absent && re(f.absent).test(text) ? [`${f.path} still has /${f.absent}/`] : [],
    ...f.same && text !== ev.fixture?.[f.path] ? [`${f.path} changed`] : [],
  ]
}

export function grade(ev: Evidence, x: Expect): string[] {
  if (ev.error) return [ev.error]
  const said = ev.replies.join('\n')
  return [
    ...(x.reply ?? []).filter(r => !re(r).test(said)).map(r => `reply never matched /${r}/`),
    ...(x.noReply ?? []).filter(r => re(r).test(said)).map(r => `reply matched /${r}/`),
    ...(x.used ?? []).filter(r => !ev.tools.some(t => re(r).test(t))).map(r => `tool /${r}/ never used`),
    ...(x.unused ?? []).filter(r => ev.tools.some(t => re(r).test(t))).map(r => `tool /${r}/ used`),
    ...count('cards', ev.cards.length, x.cards),
    ...count('settings', ev.settings.length, x.settings),
    ...x.setting ? ev.settings.map(v => `${v.key}=${String(v.value)}`).filter(v => !new RegExp(x.setting!).test(v)).map(v => `setting ${v} does not match /${x.setting}/`) : [],
    ...count('jobs', ev.jobs.length, x.jobs),
    ...x.jobCron ? ev.jobs.filter(j => !new RegExp(x.jobCron!).test(j.cron)).map(j => `job cron ${j.cron} does not match /${x.jobCron}/`) : [],
    ...(x.files ?? []).flatMap(f => fileMisses(ev, f)),
    ...(x.commands ?? []).filter(c => ev.commands[c] !== 0).map(c => `${c} exited ${ev.commands[c] ?? 'never'}`),
  ]
}

export function fixtureText(spec: string | Generated): string {
  if (typeof spec === 'string') return spec
  return Array.from({ length: spec.times }, (_, i) => spec.at?.[String(i + 1)] ?? spec.repeat.replaceAll('{i}', String(i + 1))).join('\n') + '\n'
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0 }
const perTurn = (ev: Evidence) => ev.turns.length ? Math.round(ev.turns.reduce((n, t) => n + t.tokensIn, 0) / ev.turns.length) : 0

export function summarize(name: string, runs: Evidence[], misses: string[][]): Row {
  const valid = runs.map((ev, i) => ({ ev, miss: misses[i]! })).filter(r => !r.ev.infra)
  const measured = valid.filter(r => r.ev.turns.length).map(r => r.ev)
  const tokens = measured.map(perTurn)
  return {
    name, passes: valid.filter(r => !r.miss.length).length, runs: valid.length, infra: runs.length - valid.length,
    tokensIn: { median: median(tokens), min: tokens.length ? Math.min(...tokens) : 0, max: tokens.length ? Math.max(...tokens) : 0 },
    steps: median(measured.map(r => r.turns.reduce((n, t) => n + t.steps, 0))),
    misses: valid.map(r => r.miss).filter(m => m.length),
  }
}

export function gate(before: Row[], after: Row[]): string[] {
  return before.flatMap(b => {
    const a = after.find(r => r.name === b.name)
    if (!a) return [`${b.name}: missing from the after run`]
    if (a.infra) return [`${b.name}: ${a.infra} run${a.infra === 1 ? '' : 's'} hit an API limit after, so run the case again`]
    const failedAfter = a.runs - a.passes, failedBefore = b.runs - b.passes
    return failedAfter >= 2 && failedBefore < 2 ? [`${b.name}: passed ${b.passes} of ${b.runs} before, ${a.passes} of ${a.runs} after`] : []
  })
}
