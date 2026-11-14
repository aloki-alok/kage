#!/usr/bin/env node
// kage reload: the running hub checks config.json and secrets.json now (it also watches them). A changed people list
// applies to the next message, and no session is cut. Any other key restarts the hub once it is quiet. A wrong file changes nothing.
import { fileURLToPath } from 'node:url'
import type { Reloaded } from '../core/settings.ts'
import { askHub } from './home.ts'

// Asks the hub over its socket. Rejects with a line for a person when no hub answers.
export const reload = () => askHub<Reloaded>({ type: 'reload' }).catch((e: Error) => {
  throw new Error(e.message === 'silent' ? 'The hub did not answer. It may run older code: kage restart applies the file.' : 'Kage is not running, so the file is read at the next kage start.')
})

// What the hub answered, as lines for a person.
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
