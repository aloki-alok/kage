import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, realpathSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { delimiter } from 'node:path'
import { ssmEligible, startSessionCall } from '../core/ssm.ts'

const INSTALL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/sessionmanagerplugin/bin']

export function findPlugin(pathEnv = process.env.PATH ?? '', skip: string[] = [], installDirs = INSTALL_DIRS): string | undefined {
  const real = (d: string) => { try { return realpathSync(d) } catch { return d } }
  for (const dir of [...pathEnv.split(delimiter).filter(Boolean), ...installDirs]) {
    if (skip.some(x => real(x) === real(dir))) continue
    const f = `${dir}/session-manager-plugin`
    try { accessSync(f, constants.X_OK); return f } catch {}
  }
}

export function ssmRelay(o: { path: string; trusted: (key: string) => boolean; turnOf?: (key: string) => string | undefined; everyMs?: number; log: (...a: unknown[]) => void; plugin: string | undefined; max?: number }) {
  const tokens = new Map<string, string>()
  const keyOf = new Map<string, string>()
  let active = 0
  const refuse = (s: Socket, why: string) => s.end(`error: ${why}\n`)
  const server = createServer({ allowHalfOpen: true }, s => {
    s.on('error', () => {})
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk
      const i = buf.indexOf('\n')
      if (i < 0) { if (buf.length > 16384) { s.off('data', onData); refuse(s, 'header too long') } return }
      s.off('data', onData)
      s.pause()
      const rest = Buffer.from(buf.slice(i + 1), 'binary')
      const h = (() => { try { const j = JSON.parse(buf.slice(0, i)) as { token?: unknown; args?: unknown }; return typeof j.token === 'string' ? { token: j.token, args: j.args } : undefined } catch { return undefined } })()
      if (!h) return refuse(s, 'expected one JSON line: {token, args}')
      const key = tokens.get(h.token)
      if (!key || !o.trusted(key)) return refuse(s, 'no relay for this session')
      const c = startSessionCall(h.args)
      if ('error' in c) { o.log('ssm relay refused for', key, c.error); return refuse(s, c.error) }
      if (!o.plugin) return refuse(s, "session-manager-plugin is not on the hub's PATH")
      if (active >= (o.max ?? 8)) return refuse(s, 'too many relays')
      active++
      const p = spawn(o.plugin, c.args, { stdio: ['pipe', 'pipe', 'ignore'] })
      let done = false
      const turn = o.turnOf?.(key)
      const held = turn === undefined ? undefined : setInterval(() => { if (o.turnOf!(key) !== turn) p.kill() }, o.everyMs ?? 1000)
      const end = (why: string) => { if (done) return; done = true; clearInterval(held); active--; o.log('ssm relay', c.region, c.target, 'for', key, why); s.end() }
      p.on('error', e => { if (!done) { done = true; clearInterval(held); active--; o.log('ssm relay', c.region, c.target, 'for', key, `failed ${(e as NodeJS.ErrnoException).code}`); refuse(s, 'the plugin did not start') } })
      p.on('spawn', () => {
        s.write('ok\n')
        if (rest.length) p.stdin.write(rest)
        s.pipe(p.stdin)
        p.stdout.pipe(s, { end: false })
        s.resume()
      })
      p.stdin.on('error', () => {})
      p.on('close', (code, sig) => end(`exit ${code ?? sig}`))
      s.on('close', () => { if (!done) p.kill() })
    }
    s.on('data', onData)
  })
  try { unlinkSync(o.path) } catch {}
  const mask = process.umask(0o177)
  server.listen(o.path)
  process.umask(mask)
  chmodSync(o.path, 0o600)
  return {
    issue(key: string, ownerSession = false) {
      if (!ssmEligible(key) || !(ownerSession || o.trusted(key))) return
      this.drop(key)
      const t = randomBytes(24).toString('hex')
      tokens.set(t, key); keyOf.set(key, t)
      return t
    },
    drop(key: string) { const t = keyOf.get(key); if (t) tokens.delete(t); keyOf.delete(key) },
    close() { server.close(); try { unlinkSync(o.path) } catch {} },
  }
}
