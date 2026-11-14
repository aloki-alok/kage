// kage doctor's Jev line: checks the Jev settings, then asks Jev about one fixed ack (never a real post).
// Prints one line. Exit 0 with no output when Jev is off, 0 with the line when it works, 1 on a problem.
import { readFileSync } from 'node:fs'
import { parseEnv } from '../core/settings.ts'
import { jevConfig } from '../core/jev.ts'
import { appEntry } from '../core/registry.ts'
import { jevCheck } from '../connectors/jev.ts'

const env = parseEnv(readFileSync(process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`, 'utf8'))
const c = jevConfig(env)
if (!c) process.exit(0)
if ('error' in c) { console.log(`jev: ${c.error}`); process.exit(1) }
const trusted = (env.KAGE_TRUSTED_APPS || '').split(',').map(s => appEntry(s.trim())?.id).filter(Boolean)
const unlisted = c.agents === 'all' ? [] : c.agents.filter(a => !trusted.includes(a))
if (unlisted.length) { console.log(`jev: KAGE_JEV_AGENTS has ${unlisted.join(', ')}, which KAGE_TRUSTED_APPS does not list. Add it with kage add <app id> <owner>`); process.exit(1) }
const v = await jevCheck({ ...c, agents: 'all' })('doctor', 'Done, I posted the summary in the thread. Thanks!')
if (!/needs_reply/.test(v.why)) { console.log(`JEV_API_KEY: ${v.why.replace(', answering anyway', '')}. Check the key, or remove JEV_API_KEY to turn Jev off`); process.exit(1) }
if (v.reply) { console.log(`jev scored a plain ack as needing a reply (${v.why}): lower KAGE_JEV_THRESHOLD`); process.exit(1) }
const who = c.agents === 'all' ? 'every listed agent' : c.agents.join(', ')
console.log(`JEV_API_KEY accepted by Jev; it checks ${who} (a test ack: ${v.why.replace(/^jev /, '')})`)
