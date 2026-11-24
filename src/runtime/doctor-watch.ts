import { execFile } from 'node:child_process'
import { doctorBug, doctorNews, failureNews, repeatedFailures, type FailuresTold } from '../core/doctor.ts'
import type { IssueReport } from '../core/issue-report.ts'

type Options = {
  run: () => Promise<string>
  store: { load(key: string): unknown; save(key: string, value: unknown): void }
  say: (text: string) => Promise<boolean>
  event: (detail: string) => void
  file?: (r: IssueReport) => Promise<void>
  canFile?: () => Promise<boolean>
  now?: () => number
}

export const runDoctor = (code: string, timeout = 120_000) => () => new Promise<string>(ok => {
  execFile(`${code}/setup.sh`, ['doctor', '--fix', '--skip=whatsapp,scopes'], { cwd: code, timeout }, (e, out) =>
    ok(`${String(out ?? '')}${e?.killed ? `\nFAIL  the doctor took over ${timeout / 1000} s, so some checks did not finish` : ''}`))
})

export function doctorWatch(o: Options) {
  return async () => {
    const told = (o.store.load('doctor-told') ?? []) as string[], out = await o.run().catch(() => '')
    for (const l of out.split('\n').filter(l => l.startsWith('fixed '))) o.event(`doctor fixed: ${l.slice(6).trim()}`)
    const n = doctorNews(out, told, (o.store.load('doctor-last') ?? []) as string[])
    o.store.save('doctor-last', n.failing)
    o.event(`doctor failing=${n.failing.length} told=${n.stable.length}`)
    if (n.dm && !await o.say(n.dm)) return
    o.store.save('doctor-told', n.stable)
    const now = (o.now ?? Date.now)(), filed = (o.store.load('doctor-filed') ?? {}) as Record<string, number>
    const due = n.stable.filter(f => filed[f] === undefined || now - filed[f] >= 86_400_000).flatMap(f => { const r = doctorBug(f); return r ? [[f, r] as const] : [] })
    if (!o.file || !due.length || !await (o.canFile?.() ?? Promise.resolve(true))) return
    for (const [f, r] of due) await o.file(r).then(() => { filed[f] = now }, () => o.event('doctor file failed'))
    o.store.save('doctor-filed', filed)
  }
}

export function failureWatch(o: Pick<Options, 'store' | 'say'> & { events: () => { kind: string; detail: string }[]; day: () => string; atLeast: () => number }) {
  return async () => {
    const before = (o.store.load('failures-told') ?? { day: '', told: [] }) as FailuresTold
    const n = failureNews(repeatedFailures(o.events(), o.atLeast()), before, o.day())
    if (n.dm && !await o.say(n.dm)) return
    o.store.save('failures-told', n.told)
  }
}
