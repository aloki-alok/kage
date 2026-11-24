import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { placeFor } from '../core/conversations.ts'
import { tilde } from '../core/config.ts'
import { envFilePath, hasSettings, readSettings } from '../runtime/config-files.ts'
import { askSocket } from '../runtime/hub-client.ts'
import { readOwnerKey } from '../runtime/owner-key.ts'
import { errVoice } from './voice.ts'

export const notRunning = (): never => { console.error(errVoice.says("I'm not running. Start me with kage start.")); process.exit(3) }
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

const READ_TOKEN = process.env.KAGE_READ_TOKEN
export const inTerminal = !process.env.KAGE_SESSION && !process.env.KAGE_THREAD
export const asOwner = (question: object) => ({ ...question, ownerKey: readOwnerKey(DIR), ...READ_TOKEN && { readToken: READ_TOKEN } })
export const askHub = <T>(question: object, timeoutMs = 5000) => askSocket<T>(`${DIR}/router.sock`, asOwner(question), timeoutMs)
