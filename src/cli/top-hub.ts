import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

export function hubAsker(path: string) {
  let sock: Socket | undefined
  let waiters: ((m: any) => void)[] = []
  function hub(): Socket | undefined {
    if (sock && !sock.destroyed) return sock
    if (!existsSync(path)) return undefined
    const s = connect(path)
    let buf = ''
    s.on('data', b => {
      buf += b
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        let m: any
        try { m = JSON.parse(buf.slice(0, i)) } catch {}
        buf = buf.slice(i + 1)
        if (m) waiters.shift()?.(m)
      }
    })
    s.on('error', () => {})
    s.on('close', () => { if (sock === s) sock = undefined; waiters = [] })
    sock = s
    return s
  }
  return (m: object) => new Promise<any>(resolve => {
    const s = hub()
    if (!s) return resolve(undefined)
    const w = (r: any) => { clearTimeout(t); resolve(r) }
    const t = setTimeout(() => { waiters = waiters.filter(x => x !== w); resolve(undefined) }, 3000)
    waiters.push(w)
    s.write(JSON.stringify(m) + '\n')
  })
}
