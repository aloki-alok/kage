// One hub per machine. The lock is a listening socket: binding is atomic, and the OS releases it when the hub
// dies, however it dies. A socket file with nobody listening is a dead hub's, and one starter at a time removes it.
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

// true: this process holds the lock until it exits. false: another live process holds it.
export async function hubLock(path: string): Promise<boolean> {
  const taking = `${path}.taking`
  let mine = false
  try {
    for (let i = 0; i < 50; i++) {
      const e = await listen(path)
      if (!e) return true
      if (e.code !== 'EADDRINUSE' && e.code !== 'EEXIST') throw e   // macOS says either when the path is taken
      if (await answers(path)) return false
      // A dead hub's file. Whoever creates the taking file removes it; the rest wait and look again.
      try { closeSync(openSync(taking, 'wx')); mine = true } catch {
        try { if (Date.now() - statSync(taking).mtimeMs > 5000) unlinkSync(taking) } catch {}
        await new Promise(r => setTimeout(r, 100))
        continue
      }
      // Look again: a starter that took over before us frees the taking file only once it listens.
      if (await answers(path)) return false
      try { unlinkSync(path) } catch {}
    }
    throw new Error(`could not take the hub lock ${path}`)
  } finally {
    if (mine) try { unlinkSync(taking) } catch {}
  }
}
