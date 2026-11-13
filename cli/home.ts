// Where this Kage keeps its env, database and ledgers, shared by every kage command.
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { placeFor } from '../core/conversations.ts'

export const ENV_FILE = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
export const DIR = dirname(ENV_FILE)

// Session key to a readable place ("#telephony"), read from the hub's store.
export function placeNamer(): (key: string) => string {
  try {
    const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
    const names = new Map((db.prepare('select key, place from conversations').all() as { key: string; place: string }[]).map(r => [r.key, r.place]))
    db.close()
    return k => placeFor(k2 => names.get(k2), k)
  } catch {
    return k => k
  }
}

// One question to the running hub over its socket, and its one-line answer. Rejects with 'down' when no hub
// is there, and with 'silent' when it does not answer in 5 s (a hub from before the question existed).
export function askHub<T>(question: object): Promise<T> {
  const SOCK = `${DIR}/router.sock`
  return new Promise((res, rej) => {
    if (!existsSync(SOCK)) return rej(new Error('down'))
    const s = connect(SOCK)
    let buf = ''
    s.setTimeout(5000, () => { s.destroy(); rej(new Error('silent')) })
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
