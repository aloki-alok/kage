import { execFile } from 'node:child_process'
import { doctorNews } from '../core/doctor.ts'

type Options = {
  run: () => Promise<string>
  store: { load(key: string): unknown; save(key: string, value: unknown): void }
  say: (text: string) => Promise<boolean>
  event: (detail: string) => void
}

export const runDoctor = (code: string) => () => new Promise<string>(ok => {
  execFile(`${code}/setup.sh`, ['doctor'], { cwd: code, timeout: 120_000 }, (_e, out) => ok(String(out ?? '')))
})

export function doctorWatch(o: Options) {
  return async () => {
    const n = doctorNews(await o.run().catch(() => ''), (o.store.load('doctor-told') ?? []) as string[])
    o.event(`doctor failing=${n.failing.length}`)
    if (n.dm && !await o.say(n.dm)) return
    o.store.save('doctor-told', n.failing)
  }
}
