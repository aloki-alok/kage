import type { Line } from './doctor.ts'
import { oneLine } from './text.ts'

export type Proc = { pid: number; cpu: number; ageSec: number; cwdGone: boolean; command: string }
export type Container = { engine: 'docker' | 'podman'; name: string; restarts: number; startedSec: number; restarting: boolean }

const TEST_RUN_SEC = 10 * 60
const HOUR_SEC = 60 * 60
const isTestRun = (command: string) => /^\S*\bnode\b.*\s--test(\s|$)/.test(command) && !/\s--watch(\s|$)/.test(command)

export function leftoverProcess(p: Proc): string | undefined {
  if (p.cwdGone) return 'its folder is gone'
  if (isTestRun(p.command) && p.ageSec > TEST_RUN_SEC) return 'a test run older than 10 minutes'
}

export const crashLooping = (c: Container) => c.restarting || (c.restarts > 0 && c.startedSec < HOUR_SEC)

const age = (sec: number) => sec >= HOUR_SEC ? `${Math.floor(sec / HOUR_SEC)} h` : `${Math.max(1, Math.floor(sec / 60))} min`
const short = (s: string) => { const t = oneLine(s); return t.length > 120 ? `${t.slice(0, 117)}...` : t }

export function leftoverLines(procs: Proc[], containers: Container[], own: number[]): Line[] {
  const lines: Line[] = []
  for (const p of procs) {
    const why = own.includes(p.pid) ? undefined : leftoverProcess(p)
    if (why) lines.push({ kind: 'note', text: `leftover process ${p.pid} (${Math.round(p.cpu)}% CPU, up ${age(p.ageSec)}): ${why}. ${short(p.command)}. Stop it: kill ${p.pid}` })
  }
  for (const c of containers.filter(crashLooping)) lines.push({ kind: 'note', text: `container ${c.name} restarted ${c.restarts} times, last within the hour: it looks stuck in a crash loop. Stop it: ${c.engine} stop ${c.name}` })
  return lines
}

export function startedAt(s: string): number {
  const m = s.trim().match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?\s*(Z|[+-]\d\d:?\d\d)?/)
  if (!m) return NaN
  const zone = !m[4] || m[4] === 'Z' ? 'Z' : `${m[4].slice(0, 3)}:${m[4].slice(-2)}`
  return Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? '0').slice(0, 3).padEnd(3, '0')}${zone}`)
}

export const leftoversLine = (n: number) => n === 1
  ? '1 leftover process or container slows this machine: kage doctor lists it'
  : `${n} leftover processes or containers slow this machine: kage doctor lists them`

export function elapsedSeconds(s: string): number {
  const t = s.trim()
  if (/^\d+$/.test(t)) return Number(t)
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  return m ? Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0
}
