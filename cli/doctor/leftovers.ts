import { execFile } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { elapsedSeconds, leftoverLines, startedAt, type Container, type Proc } from '../../core/leftovers.ts'
import type { Group } from './context.ts'

const run = (cmd: string, args: string[], timeout = 5000) => promisify(execFile)(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 8 << 20 }).then(r => r.stdout, () => '')

async function cwdsOnMac(uid: number): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const l of (await run('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn'], 10_000)).split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1))
    else if (l.startsWith('n') && pid) cwds.set(pid, l.slice(1))
  }
  return cwds
}

function cwdGone(pid: number, mac: Map<number, string> | undefined): boolean {
  if (mac) { const cwd = mac.get(pid); return !!cwd && !existsSync(cwd) }
  try { return readlinkSync(`/proc/${pid}/cwd`).endsWith(' (deleted)') } catch { return false }
}

async function processes(): Promise<Proc[]> {
  const uid = userInfo().uid
  const [mac, out] = await Promise.all([process.platform === 'darwin' ? cwdsOnMac(uid) : undefined, run('ps', ['-o', 'pid=,pcpu=,etime=,args=', '-u', String(uid)], 10_000)])
  return out.split('\n').flatMap(l => {
    const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/)
    if (!m) return []
    const pid = Number(m[1])
    return [{ pid, cpu: Number(m[2]), ageSec: elapsedSeconds(m[3]!), cwdGone: cwdGone(pid, mac), command: m[4]! }]
  })
}

async function containers(now: number): Promise<Container[]> {
  const found = await Promise.all((['docker', 'podman'] as const).map(async engine => {
    const ids = (await run(engine, ['ps', '-q'])).split('\n').filter(Boolean)
    if (!ids.length) return []
    const out = await run(engine, ['inspect', '--format', '{{.Name}}\t{{.RestartCount}}\t{{.State.StartedAt}}\t{{.State.Restarting}}', ...ids])
    return out.split('\n').filter(Boolean).map(l => {
      const [name, restarts, started, restarting] = l.split('\t')
      const sec = (now - startedAt(started!)) / 1000
      return { engine, name: name!.replace(/^\//, ''), restarts: Number(restarts) || 0, startedSec: Number.isFinite(sec) ? Math.max(0, sec) : Infinity, restarting: restarting === 'true' }
    })
  }))
  return found.flat()
}

export const leftovers: Group = async () => {
  const [procs, boxes] = await Promise.all([processes(), containers(Date.now())])
  return leftoverLines(procs, boxes, [process.pid, process.ppid])
}
