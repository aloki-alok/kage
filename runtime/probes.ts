// Tripwire probes on disk and in a process: the pin of each script a probe command names, and one bounded run
// of it (core/tripwire.ts decides what the output means). A run never throws and never leaves a process behind.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { pinsChanged, safePattern, scriptPaths, type Probe } from '../core/tripwire.ts'

const hashOf = (path: string): string | undefined => {
  try { return statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined } catch { return undefined }
}

const writable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true } catch { return false }
}

// The sha256 of each file the command runs (core/tripwire.ts scriptPaths) that this user can write. A file only the
// hub's user cannot write (a system binary) needs no pin, and a data file the command reads is never run.
export function pin(command: string, home = homedir(), interpreters?: string[], cwd = process.cwd()): Record<string, string> {
  const pins: Record<string, string> = {}
  for (const p of scriptPaths(command, home, cwd, interpreters)) { const h = writable(p) ? hashOf(p) : undefined; if (h) pins[p] = h }
  return pins
}

// The variables a probe sees when tripwires.env is not set.
const DEFAULT_ENV = ['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR', 'SSH_AUTH_SOCK']

export type ProbeRun = { ok: boolean; out: string; err: string; refused?: string; ms: number }

// Runs `/bin/sh -c` in its own process group, so a timeout kills the children too. Stdout and stderr stay apart and each is capped at maxBytes; a cut
// stdout is marked. It does not run at all when an ignore pattern is unsafe, or when a pinned file changed or is gone: the owner approved that script, not the new one.
export async function runProbe(p: Probe, o: { timeoutMs: number; maxBytes: number; patternMax: number; home?: string; env?: string[] }): Promise<ProbeRun> {
  const start = Date.now()
  try {
    for (const r of p.ignore) {
      const why = safePattern(r, o.patternMax)
      if (why) return { ok: false, out: '', err: '', refused: `ignore ${why}`, ms: Date.now() - start }
    }
    const changed = pinsChanged(p.pins, Object.fromEntries(Object.keys(p.pins).map(f => [f, hashOf(f)])))
    if (changed.length) return { ok: false, out: '', err: '', refused: `changed or missing: ${changed.join(', ')}`, ms: Date.now() - start }
    return await new Promise<ProbeRun>(resolve => {
      // Only the listed names pass (tripwires.env): a probe is the owner's command, but it never needs the hub's tokens.
      const env: Record<string, string> = {}
      for (const k of o.env ?? DEFAULT_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!
      if (o.home) env.HOME = o.home
      const child = spawn('/bin/sh', ['-c', p.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      let buf = Buffer.alloc(0), errBuf = Buffer.alloc(0), truncated = false, timedOut = false, done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: ok && !timedOut, out: buf.toString('utf8') + (truncated ? '\n[truncated]' : ''), err: errBuf.toString('utf8'), ms: Date.now() - start })
      }
      const take = (d: Buffer) => {
        const room = o.maxBytes - buf.length
        if (d.length > room) truncated = true
        if (room > 0) buf = Buffer.concat([buf, d.subarray(0, room)])
      }
      child.stdout.on('data', take)
      child.stderr.on('data', (d: Buffer) => { errBuf = Buffer.concat([errBuf, d.subarray(0, Math.max(0, o.maxBytes - errBuf.length))]) })
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, o.timeoutMs)
      child.on('error', () => finish(false))
      child.on('close', code => finish(code === 0))
    })
  } catch (e) {
    return { ok: false, out: '', err: '', refused: `could not run: ${(e as Error).message}`, ms: Date.now() - start }
  }
}
