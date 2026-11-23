#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import type { Reloaded } from '../core/settings.ts'
import { askHub } from './home.ts'

export const reload = () => askHub<Reloaded>({ type: 'reload' }).catch((e: Error) => {
  throw new Error(e.message === 'silent' ? 'The hub did not answer. It may run older code: kage restart applies the file.' : 'Kage is not running, so the file is read at the next kage start.')
})

export function said(r: Reloaded): string[] {
  if ('refused' in r) return [`Not reloaded: ${r.refused}. Kage keeps the settings it had. Fix the line, then run kage reload again.`]
  return [
    ...(r.changed.length ? r.changed.map(c => `Reloaded ${c}`) : ['Checked. No people list changed.']),
    ...(r.restart.length ? [`Kage restarts by itself once every session is quiet, to apply: ${r.restart.join(', ')}`] : []),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = await reload()
    for (const l of said(r)) console.log(l)
    if ('refused' in r) process.exitCode = 1
  } catch (e) { console.error((e as Error).message); process.exitCode = 1 }
}
