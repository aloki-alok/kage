import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { commandWords, lineHasher, pinsChanged, safePattern, type Probe } from '../core/tripwire.ts'

const ABSENT = 'absent'

const stateOf = (path: string): string | undefined => {
  try { return statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : undefined }
}

const writable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true } catch { return false }
}

const swappable = (path: string): boolean => {
  try { return [path, dirname(path), realpathSync(path), dirname(realpathSync(path))].some(writable) } catch { return writable(dirname(path)) }
}

const expand = (w: string, home: string) => (w === '~' ? home : w.startsWith('~/') ? home + w.slice(1) : w)

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

const DEFAULT_ENV = ['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR', 'SSH_AUTH_SOCK']

export type ProbeRun = { ok: boolean; out: string; err: string; fp: string; truncated: boolean; refused?: string; ms: number; why?: string }

export async function runProbe(p: Probe, o: { timeoutMs: number; maxBytes: number; patternMax: number; lineMax: number; home?: string; env?: string[]; job?: { id: string; stateDir: string } }): Promise<ProbeRun> {
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
      const env: Record<string, string> = {}
      for (const k of o.env ?? DEFAULT_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!
      if (o.home) env.HOME = o.home
      if (o.job) { env.KAGE_JOB_ID = o.job.id; env.KAGE_JOB_STATE_DIR = o.job.stateDir }
      const child = spawn('/bin/sh', ['-c', p.command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      const hasher = lineHasher(p.ignore, o.lineMax), decoder = new StringDecoder('utf8')
      let buf = Buffer.alloc(0), errBuf = Buffer.alloc(0), truncated = false, timedOut = false, done = false
      const finish = (code: number | null | 'spawn') => {
        if (done) return
        done = true
        clearTimeout(timer)
        hasher.push(decoder.end())
        const why = timedOut ? 'timeout' : code === 'spawn' ? 'spawn' : code === 0 ? undefined : `exit-${code ?? 'signal'}`
        resolve({ ok: !why, ...why && { why }, out: buf.toString('utf8') + (truncated ? '\n[truncated]' : ''), err: errBuf.toString('utf8'), fp: hasher.end(), truncated, ms: Date.now() - start })
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
      child.on('error', () => finish('spawn'))
      child.on('close', code => finish(code))
    })
  } catch (e) {
    return refuse(`could not run: ${(e as Error).message}`)
  }
}
