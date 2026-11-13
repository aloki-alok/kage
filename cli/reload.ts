#!/usr/bin/env node
// kage reload: the running hub reads the settings file again. A changed allow list (KAGE_TEAMMATES,
// KAGE_TRUSTED_APPS) applies to the next message, and no session is cut. A wrong file changes nothing.
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Reloaded } from '../core/settings.ts'
import { DIR } from './home.ts'

// Asks the hub over its socket. Rejects when no hub answers within 5 s (a hub from before this command stays silent).
export function reload(): Promise<Reloaded> {
  const SOCK = `${DIR}/router.sock`
  return new Promise((res, rej) => {
    const down = () => rej(new Error('Kage is not running, so the file is read at the next kage start.'))
    if (!existsSync(SOCK)) return down()
    const s = connect(SOCK)
    let buf = ''
    s.setTimeout(5000, () => { s.destroy(); rej(new Error('The hub did not answer. It may run older code: kage restart applies the file.')) })
    s.on('connect', () => s.write(JSON.stringify({ type: 'reload' }) + '\n'))
    s.on('data', b => {
      buf += b
      const i = buf.indexOf('\n')
      if (i < 0) return
      s.destroy()
      res(JSON.parse(buf.slice(0, i)) as Reloaded)
    })
    s.on('error', down)
  })
}

// What the hub answered, as lines for a person.
export function said(r: Reloaded): string[] {
  if ('refused' in r) return [`Not reloaded: ${r.refused}. Kage keeps the settings it had. Fix the line, then run kage reload again.`]
  return [
    ...(r.changed.length ? r.changed.map(c => `Reloaded ${c}`) : ['Reloaded. No allow list changed.']),
    ...(r.restart.length ? [`Needs a restart (kage restart): ${r.restart.join(', ')}`] : []),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = await reload()
    for (const l of said(r)) console.log(l)
    if ('refused' in r) process.exitCode = 1
  } catch (e) { console.error((e as Error).message); process.exitCode = 1 }
}
