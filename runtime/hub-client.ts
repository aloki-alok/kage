// The client end of the hub's socket (runtime/session-link.ts is the server). Node modules only, because
// cli/home.ts imports it and service.sh reads settings through that file.
import { existsSync } from 'node:fs'
import { connect } from 'node:net'

// One question to the running hub over its socket, and its one-line answer. Rejects with 'down' when no hub
// is there, and with 'silent' when it does not answer in time (a hung hub, or one from before the question existed).
export function askSocket<T>(SOCK: string, question: object, timeoutMs = 5000): Promise<T> {
  return new Promise((res, rej) => {
    if (!existsSync(SOCK)) return rej(new Error('down'))
    const s = connect(SOCK)
    let buf = ''
    s.setTimeout(timeoutMs, () => { s.destroy(); rej(new Error('silent')) })
    s.on('connect', () => s.write(JSON.stringify(question) + '\n'))
    s.on('data', b => {
      buf += b
      const i = buf.indexOf('\n')
      if (i < 0) return
      s.destroy()
      res(JSON.parse(buf.slice(0, i)) as T)
    })
    s.on('error', () => rej(new Error('down')))
  })
}
