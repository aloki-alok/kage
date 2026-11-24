import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY_SHAPE = /^[0-9a-f]{64}$/
const keyFile = (dir: string) => join(dir, 'owner.key')

export function readOwnerKey(dir: string): string {
  try {
    const key = readFileSync(keyFile(dir), 'utf8').trim()
    return KEY_SHAPE.test(key) ? key : ''
  } catch { return '' }
}

export function ownerKey(dir: string): { key: string; made: boolean } {
  const kept = readOwnerKey(dir)
  if (kept) return { key: kept, made: false }
  const key = randomBytes(32).toString('hex')
  const fresh = `${keyFile(dir)}.${process.pid}.new`
  writeFileSync(fresh, key, { mode: 0o600 })
  renameSync(fresh, keyFile(dir))
  return { key, made: true }
}

export const linkToken = (key: string, thread: string) => createHmac('sha256', key).update(thread).digest('hex')
export const readToken = (key: string) => createHmac('sha256', key).update('\0read').digest('hex')
export const paneHello = (thread: string, env: NodeJS.ProcessEnv = process.env) => ({ type: 'hello' as const, key: thread, linkToken: env.KAGE_LINK_TOKEN ?? '' })

export function sameSecret(given: unknown, want: string): boolean {
  if (typeof given !== 'string' || !want) return false
  const a = Buffer.from(given), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}
