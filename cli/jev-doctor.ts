// kage doctor's Jev line: checks the Jev settings, then asks Jev about one fixed ack (never a real post).
// Prints one line. Exit 0 with no output when Jev is off, 0 with the line when it works, 1 on a problem.
import { readSettings } from '../runtime/config-files.ts'
import { jevConfig } from '../core/jev.ts'
import { jevCheck } from '../connectors/jev.ts'

const { config, secrets } = readSettings(process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`)
const c = jevConfig(config.jev, secrets.jevKey)
if (!c) process.exit(0)
if ('error' in c) { console.log(`jev: ${c.error}`); process.exit(1) }
const trusted = (config.people?.agents ?? []).map(a => a.app)
const unlisted = c.agents === 'all' ? [] : c.agents.filter(a => !trusted.includes(a))
if (unlisted.length) { console.log(`jev: jev.agents has ${unlisted.join(', ')}, which people.agents does not list. Add it with kage add <app id> <owner>`); process.exit(1) }
const v = await jevCheck({ ...c, agents: 'all' })('doctor', 'Done, I posted the summary in the thread. Thanks!')
if (!/needs_reply/.test(v.why)) { console.log(`jevKey: ${v.why.replace(', answering anyway', '')}. Check the key, or remove jevKey to turn Jev off`); process.exit(1) }
if (v.reply) { console.log(`jev scored a plain ack as needing a reply (${v.why}): lower jev.threshold`); process.exit(1) }
const who = c.agents === 'all' ? 'every listed agent' : c.agents.join(', ')
console.log(`jevKey accepted by Jev; it checks ${who} (a test ack: ${v.why.replace(/^jev /, '')})`)
