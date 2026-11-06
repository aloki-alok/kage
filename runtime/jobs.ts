// The hub's timed work in one place: each job runs on its own period from one clock. A job that
// fails is logged and tried again next period; an async job still running is not started again.
import { log } from '../config.ts'

export type Job = { name: string; every: number; run: (now: number) => void | Promise<void> }

export function jobRunner(jobs: Job[], start: number, onError = (name: string, e: unknown) => log(`job ${name} failed`, e)) {
  const last = new Map(jobs.map(j => [j.name, start]))
  const running = new Set<string>()
  return {
    tick(now: number) {
      for (const j of jobs) {
        if (running.has(j.name) || now - last.get(j.name)! < j.every) continue
        last.set(j.name, now)
        try {
          const p = j.run(now)
          if (p) {
            running.add(j.name)
            p.catch(e => onError(j.name, e)).finally(() => running.delete(j.name))
          }
        } catch (e) { onError(j.name, e) }
      }
    },
  }
}

// One clock for every job. Ten seconds is fine enough for the shortest period (schedules, 20 s).
export function runJobs(jobs: Job[]) {
  const runner = jobRunner(jobs, Date.now())
  return setInterval(() => runner.tick(Date.now()), 10_000)
}
