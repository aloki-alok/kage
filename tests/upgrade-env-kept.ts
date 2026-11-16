// For tests/upgrade-drill.sh, run inside the upgraded install after the hub's first start imported the env file: every
// line comes back, a known setting from the settings files and a person's own key (#300) from unknownEnv, the env
// the hub gives sessions (hub.ts). An old name comes back under its new one. Prints names only, never values.
//   node tests/upgrade-env-kept.ts <settings folder> <copy of the env file from before the import>
import { readFileSync } from 'node:fs'
import { ALIASES, toEnv, unknownEnv } from '../core/config.ts'
import { parseEnv } from '../core/settings.ts'

const [dir, before] = process.argv.slice(2) as [string, string]
const json = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
const config = json('config.json'), secrets = json('secrets.json')
const sessions = unknownEnv(config, secrets), all = toEnv(config, secrets)
const lines = Object.entries(parseEnv(readFileSync(before, 'utf8')))
const lost = lines.filter(([k, v]) => (k.startsWith('MY_') ? sessions[k] : all[ALIASES[k] ?? k]) !== v).map(([k]) => k)
if (lost.length) { console.error(`lost or changed: ${lost.join(', ')}`); process.exit(1) }
console.error(`ok: all ${lines.length} env lines kept, ${Object.keys(sessions).length} of them in the sessions' env`)
