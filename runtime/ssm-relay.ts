// The SSM relay (#161). A sandboxed session cannot reach AWS: session-manager-plugin opens its own websocket and ignores the sandbox's
// proxy. So the hub, outside the sandbox, runs `aws ssm start-session` for it. The session's ssh ProxyCommand (cli/ssm-proxy.ts) connects
// to this unix socket, sends one header line (core/ssm.ts), reads `ok` or `error: <why>`, then pipes ssh's bytes both ways.
// Only owner-only Slack threads get a token (issue), and trust is checked again on every connection. The log holds target and exit, never bytes.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { relayHeader, ssmEligible } from '../core/ssm.ts'

export function ssmRelay(o: { path: string; trusted: (key: string) => boolean; log: (...a: unknown[]) => void; aws?: string; max?: number }) {
  const tokens = new Map<string, string>()   // token -> session key
  const keyOf = new Map<string, string>()    // session key -> token
  let active = 0
  const refuse = (s: Socket, why: string) => s.end(`error: ${why}\n`)
  const server = createServer({ allowHalfOpen: true }, s => {   // a client that finishes sending still reads the answer
    s.on('error', () => {})
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk
      const i = buf.indexOf('\n')
      if (i < 0) { if (buf.length > 512) { s.off('data', onData); refuse(s, 'header too long') } return }
      s.off('data', onData)
      s.pause()
      const rest = Buffer.from(buf.slice(i + 1), 'binary')
      const h = relayHeader(buf.slice(0, i))
      if ('error' in h) return refuse(s, h.error)
      const key = tokens.get(h.token)
      if (!key || !o.trusted(key)) return refuse(s, 'no relay for this session')
      if (active >= (o.max ?? 8)) return refuse(s, 'too many relays')
      active++
      const args = ['ssm', 'start-session', '--target', h.target, '--document-name', 'AWS-StartSSHSession', '--parameters', `portNumber=${h.port}`, ...h.region ? ['--region', h.region] : []]
      const p = spawn(o.aws ?? 'aws', args, { stdio: ['pipe', 'pipe', 'ignore'] })
      let done = false
      const end = (why: string) => { if (done) return; done = true; active--; o.log('ssm relay', h.target, why); s.end() }
      p.on('error', e => { if (!done) { done = true; active--; o.log('ssm relay', h.target, `failed ${(e as NodeJS.ErrnoException).code}`); refuse(s, 'aws did not start') } })
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
  const mask = process.umask(0o177)   // the socket is born 600, with no window before the chmod
  server.listen(o.path)
  process.umask(mask)
  chmodSync(o.path, 0o600)
  return {
    // A token for an owner-only Slack thread, else undefined. One token per session key: a new start replaces the old one.
    issue(key: string) {
      if (!ssmEligible(key) || !o.trusted(key)) return
      this.drop(key)
      const t = randomBytes(24).toString('hex')
      tokens.set(t, key); keyOf.set(key, t)
      return t
    },
    drop(key: string) { const t = keyOf.get(key); if (t) tokens.delete(t); keyOf.delete(key) },
    close() { server.close(); try { unlinkSync(o.path) } catch {} },
  }
}
