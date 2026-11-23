import { closeSync, openSync, statSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'

const listen = (path: string) => new Promise<NodeJS.ErrnoException | undefined>(r => {
  const s = createServer(c => c.end())
  s.once('error', r).listen(path, () => { s.unref(); r(undefined) })
})
const answers = (path: string) => new Promise<boolean>(r => {
  const c = connect(path)
  c.once('connect', () => { c.destroy(); r(true) }).once('error', () => r(false))
})

export async function hubLock(path: string): Promise<boolean> {
  const taking = `${path}.taking`
  let mine = false
  try {
    for (let i = 0; i < 50; i++) {
      const e = await listen(path)
      if (!e) return true
      if (e.code !== 'EADDRINUSE' && e.code !== 'EEXIST') throw e
      if (await answers(path)) return false
      try { closeSync(openSync(taking, 'wx')); mine = true } catch {
        try { if (Date.now() - statSync(taking).mtimeMs > 5000) unlinkSync(taking) } catch {}
        await new Promise(r => setTimeout(r, 100))
        continue
      }
      if (await answers(path)) return false
      try { unlinkSync(path) } catch {}
    }
    throw new Error(`could not take the hub lock ${path}`)
  } finally {
    if (mine) try { unlinkSync(taking) } catch {}
  }
}
