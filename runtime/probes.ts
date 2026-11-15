// Tripwire probes on disk and in a process: the pin of each script a probe command names, and one bounded run
// of it (core/tripwire.ts decides what the output means). A run never throws and never leaves a process behind.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { commandWords, lineHasher, pinsChanged, safePattern, type Probe } from '../core/tripwire.ts'

const ABSENT = 'absent'

// What a pin records for a path: the sha256 of a file (read through a symlink), ABSENT for a missing path, or undefined
// for anything else (a folder, an unreadable file), which is never pinned.
const stateOf = (path: string): string | undefined => {
  try { return statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : undefined }
}

const writable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true } catch { return false }
}

// Can this user swap the file: write it, or its folder (as found, and after links), so a locked script in a writable
// folder or a symlink counts. A missing file counts when its folder is writable.
const swappable = (path: string): boolean => {
  try { return [path, dirname(path), realpathSync(path), dirname(realpathSync(path))].some(writable) } catch { return writable(dirname(path)) }
}

const expand = (w: string, home: string) => (w === '~' ? home : w.startsWith('~/') ? home + w.slice(1) : w)

// Best-effort pins for a probe command. Shell parsing is never complete, so this does not guess what runs: every word of
// the command that is a file this user could swap is pinned (its sha256, or ABSENT if the path does not exist yet, for a
// word with a slash). Relative words resolve against cwd and against each `cd` target. Files in `reads` are data the
// probe watches, and files in `writes` or after a redirect or tee are its own output, so none of them is pinned. The approval card and `reads` are the contract.
export function pin(command: string, o: { home?: string; cwd?: string; reads?: string[]; writes?: string[] } = {}): Record<string, string> {
  const home = o.home ?? homedir(), cwd = o.cwd ?? process.cwd()
  const { words, cds, outs } = commandWords(command, home)
  const dirs = [cwd, ...cds.map(c => resolve(cwd, c))]
  const skip = new Set([...(o.reads ?? []), ...(o.writes ?? [])].map(r => resolve(cwd, expand(r, home))))
  const pins: Record<string, string> = {}
  for (const w of words) {
    if (outs.includes(w)) continue
    for (const d of dirs) {
      const path = resolve(d, w)
      if (skip.has(path) || pins[path] !== undefined || !swappable(path)) continue
      const state = stateOf(path)
      if (state && (state !== ABSENT || w.includes('/'))) pins[path] = state
    }
  }
  return pins
}

// The variables a probe sees when tripwires.env is not set.
const DEFAULT_ENV = ['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR', 'SSH_AUTH_SOCK']

export type ProbeRun = { ok: boolean; out: string; err: string; fp: string; truncated: boolean; refused?: string; ms: number }

// Runs `/bin/sh -c` in its own process group, so a timeout kills the children too. Stdout and stderr stay apart and each text is capped at maxBytes (a cut stdout is marked and
// `truncated`), but `fp` hashes all of stdout after ignore, so a change past the cap still shows. It does not run at all when an ignore pattern is unsafe, or when a pinned file changed or is gone: the owner approved that script, not the new one.
export async function runProbe(p: Probe, o: { timeoutMs: number; maxBytes: number; patternMax: number; lineMax: number; home?: string; env?: string[] }): Promise<ProbeRun> {
  const start = Date.now()
  const refuse = (why: string): ProbeRun => ({ ok: false, out: '', err: '', fp: '', truncated: false, refused: why, ms: Date.now() - start })
  try {
    for (const r of p.ignore) {
      const why = safePattern(r, o.patternMax)
      if (why) return refuse(`ignore ${why}`)
    }
    const changed = pinsChanged(p.pins, Object.fromEntries(Object.keys(p.pins).map(f => [f, stateOf(f)])))
    if (changed.length) return refuse(`changed or missing: ${changed.join(', ')}`)
    return await new Promise<ProbeRun>(resolve => {
      // Only the listed names pass (tripwires.env): a probe is the owner's command, but it never needs the hub's tokens.
      const env: Record<string, string> = {}
      for (const k of o.env ?? DEFAULT_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!
      if (o.home) env.HOME = o.home
      const child = spawn('/bin/sh', ['-c', p.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      const hasher = lineHasher(p.ignore, o.lineMax), decoder = new StringDecoder('utf8')
      let buf = Buffer.alloc(0), errBuf = Buffer.alloc(0), truncated = false, timedOut = false, done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        hasher.push(decoder.end())
        resolve({ ok: ok && !timedOut, out: buf.toString('utf8') + (truncated ? '\n[truncated]' : ''), err: errBuf.toString('utf8'), fp: hasher.end(), truncated, ms: Date.now() - start })
      }
      const take = (d: Buffer) => {
        hasher.push(decoder.write(d))
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
    return refuse(`could not run: ${(e as Error).message}`)
  }
}
