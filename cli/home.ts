// Where this Kage keeps its env, database and ledgers, shared by every kage command.
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
