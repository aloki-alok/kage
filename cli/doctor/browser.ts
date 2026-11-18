import { readFileSync } from 'node:fs'
import { chromeLine } from '../../core/doctor.ts'
import { settings } from '../home.ts'
import { dir, hubRunning, nowSec, read, type Group } from './context.ts'

export const browser: Group = () => {
  if (!settings().secrets.browserToken || !hubRunning()) return []
  const [at, runs] = (read(`${dir}/browser-seen`) ?? '').split(' ')
  const disk = (JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')) as { version: string }).version
  return [chromeLine(Number(at) || 0, nowSec(), runs || undefined, disk)]
}
