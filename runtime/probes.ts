// Tripwire probes on disk and in a process: the pin of each script a probe command names, and one bounded run
// of it (core/tripwire.ts decides what the output means). A run never throws and never leaves a process behind.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { pinsChanged, scriptPaths, type Probe } from '../core/tripwire.ts'

const hashOf = (path: string): string | undefined => {
  try { return statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined } catch { return undefined }
}

// The sha256 of each file the command names. A word that is not a file is skipped.
export function pin(command: string, home = homedir()): Record<string, string> {
  const pins: Record<string, string> = {}
  for (const p of scriptPaths(command, home)) { const h = hashOf(p); if (h) pins[p] = h }
  return pins
}

export type ProbeRun = { ok: boolean; out: string; refused?: string; ms: number }

// Runs `/bin/sh -c` in its own process group, so a timeout kills the children too. Output past maxBytes is dropped and
// marked. It does not run at all when a pinned file changed or is gone: the owner approved that script, not the new one.
export async function runProbe(p: Probe, o: { timeoutMs: number; maxBytes: number; home?: string }): Promise<ProbeRun> {
  const start = Date.now()
  const home = o.home ?? homedir()
  try {
    const changed = pinsChanged(p.pins, Object.fromEntries(Object.keys(p.pins).map(f => [f, hashOf(f)])))
    if (changed.length) return { ok: false, out: '', refused: `changed or missing: ${changed.join(', ')}`, ms: Date.now() - start }
    return await new Promise<ProbeRun>(resolve => {
      // A short env on purpose: a probe is the owner's command, but it never needs the hub's tokens.
      const child = spawn('/bin/sh', ['-c', p.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' } })
      let buf = Buffer.alloc(0), truncated = false, timedOut = false, done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: ok && !timedOut, out: buf.toString('utf8') + (truncated ? '\n[truncated]' : ''), ms: Date.now() - start })
      }
      const take = (d: Buffer) => {
        const room = o.maxBytes - buf.length
        if (d.length > room) truncated = true
        if (room > 0) buf = Buffer.concat([buf, d.subarray(0, room)])
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, o.timeoutMs)
      child.on('error', () => finish(false))
      child.on('close', code => finish(code === 0))
    })
  } catch (e) {
    return { ok: false, out: '', refused: `could not run: ${(e as Error).message}`, ms: Date.now() - start }
  }
}
