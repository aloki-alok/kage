// For tests/upgrade-drill.sh, run inside the upgraded install after the hub's first start imported the env file. Each line
// of the old file comes back: a setting Kage knows from its place in the settings files (an old name under its new one),
// and any other line from unknownEnv, the env the hub gives sessions (#300). Prints names only, never values.
//   node tests/upgrade-env-kept.ts <settings folder> <copy of the env file from before the import>
import { readFileSync } from 'node:fs'
import { ALIASES, KEYS, toEnv, unknownEnv } from '../core/config.ts'
import { parseEnv } from '../core/settings.ts'

const [dir, before] = process.argv.slice(2) as [string, string]
const json = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
const config = json('config.json'), secrets = json('secrets.json')
const own = unknownEnv(config, secrets)
const placed = toEnv({ ...config, unknown: undefined }, { ...secrets, unknown: undefined })
const known = new Set(KEYS.map(k => k.env))
const lines = Object.entries(parseEnv(readFileSync(before, 'utf8')))
const lost = lines.filter(([k, v]) => {
  const name = ALIASES[k] ?? k
  return known.has(name) ? placed[name] !== v || name in own : own[k] !== v
}).map(([k]) => k)
const stray = Object.keys(own).filter(k => !lines.some(([n]) => n === k))
if (lost.length || stray.length) { console.error(`lost or changed: ${[...lost, ...stray].join(', ')}`); process.exit(1) }
console.error(`ok: all ${lines.length} env lines kept, ${Object.keys(own).length} of them in the sessions' env`)
