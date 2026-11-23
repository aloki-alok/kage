import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { placeFor } from '../core/conversations.ts'
import { tilde } from '../core/config.ts'
import { envFilePath, hasSettings, readSettings } from '../runtime/config-files.ts'
import { askSocket } from '../runtime/hub-client.ts'

export const ENV_FILE = envFilePath()
export const DIR = dirname(ENV_FILE)
export const settingsExist = () => hasSettings(ENV_FILE)
export const settings = (): ReturnType<typeof readSettings> => { try { return readSettings(ENV_FILE) } catch { return { config: { version: 1 }, secrets: {}, failed: () => [] } } }
export const CWD = tilde(settings().config.harness?.cwd || process.env.KAGE_CWD || process.env.HOME!, process.env.HOME!)

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

export const askHub = <T>(question: object, timeoutMs = 5000) => askSocket<T>(`${DIR}/router.sock`, question, timeoutMs)
