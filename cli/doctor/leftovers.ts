import { existsSync, readlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { elapsedSeconds, leftoverLines, type Container, type Proc } from '../../core/leftovers.ts'
import { onPath, sh, type Group } from './context.ts'

function cwdsOnMac(uid: number): Map<number, string> {
  const out = sh('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn'], 10_000).stdout ?? ''
  const cwds = new Map<number, string>()
  let pid = 0
  for (const l of out.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1))
    else if (l.startsWith('n') && pid) cwds.set(pid, l.slice(1))
  }
  return cwds
}

function cwdGone(pid: number, mac: Map<number, string> | undefined): boolean {
  if (mac) { const cwd = mac.get(pid); return !!cwd && !existsSync(cwd) }
  try { return readlinkSync(`/proc/${pid}/cwd`).endsWith(' (deleted)') } catch { return false }
}

function processes(): Proc[] {
  const uid = userInfo().uid
  const mac = process.platform === 'darwin' ? cwdsOnMac(uid) : undefined
  const out = sh('ps', ['-o', 'pid=,pcpu=,etime=,args=', '-u', String(uid)], 10_000).stdout ?? ''
  return out.split('\n').flatMap(l => {
    const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/)
    if (!m) return []
    const pid = Number(m[1])
    return [{ pid, cpu: Number(m[2]), ageSec: elapsedSeconds(m[3]!), cwdGone: cwdGone(pid, mac), command: m[4]! }]
  })
}

function containers(now: number): Container[] {
  return (['docker', 'podman'] as const).filter(onPath).flatMap(engine => {
    const ids = (sh(engine, ['ps', '-q'], 5000).stdout ?? '').split('\n').filter(Boolean)
    if (!ids.length) return []
    const out = sh(engine, ['inspect', '--format', '{{.Name}}\t{{.RestartCount}}\t{{.State.StartedAt}}\t{{.State.Restarting}}', ...ids], 5000).stdout ?? ''
    return out.split('\n').filter(Boolean).map(l => {
      const [name, restarts, started, restarting] = l.split('\t')
      const sec = (now - Date.parse(started!)) / 1000
      return { engine, name: name!.replace(/^\//, ''), restarts: Number(restarts) || 0, startedSec: Number.isFinite(sec) ? Math.max(0, sec) : Infinity, restarting: restarting === 'true' }
    })
  })
}

export const leftovers: Group = () => leftoverLines(processes(), containers(Date.now()), [process.pid, process.ppid])
