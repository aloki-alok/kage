import { existsSync } from 'node:fs'
import { connect } from 'node:net'

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
