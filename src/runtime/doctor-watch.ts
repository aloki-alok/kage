import { execFile } from 'node:child_process'
import { doctorNews } from '../core/doctor.ts'

type Options = {
  run: () => Promise<string>
  store: { load(key: string): unknown; save(key: string, value: unknown): void }
  say: (text: string) => Promise<boolean>
  event: (detail: string) => void
}

export const runDoctor = (code: string, timeout = 120_000) => () => new Promise<string>(ok => {
  execFile(`${code}/setup.sh`, ['doctor', '--skip=whatsapp,scopes'], { cwd: code, timeout }, (e, out) =>
    ok(`${String(out ?? '')}${e?.killed ? `\nFAIL  the doctor took over ${timeout / 1000} s, so some checks did not finish` : ''}`))
})

export function doctorWatch(o: Options) {
  return async () => {
    const n = doctorNews(await o.run().catch(() => ''), (o.store.load('doctor-told') ?? []) as string[], (o.store.load('doctor-last') ?? []) as string[])
    o.store.save('doctor-last', n.failing)
    o.event(`doctor failing=${n.failing.length} told=${n.stable.length}`)
    if (n.dm && !await o.say(n.dm)) return
    o.store.save('doctor-told', n.stable)
  }
}
