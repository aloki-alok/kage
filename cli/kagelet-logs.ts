// kage logs <kagelet>: its last 20 runs, newest first: time, cost, ok or failed, and its report. Then today's chains it was in, and its messages with their delivery state.
// It reads the files and the ledgers, so it works with the hub down.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DIR } from './home.ts'
import { parseKagelet } from '../core/kagelets.ts'
import { kageletRuns, runLine } from '../core/kagelet-view.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets.ts'
import { eventsOn, ledgerText } from '../runtime/ledger.ts'
import { chainLine, chainViews } from '../core/events.ts'
import { kageletMessages } from '../runtime/store.ts'
import { clockTime } from '../core/board.ts'

const name = process.argv[2] ?? ''
const file = readKagelets(kageletsDir(DIR)).find(f => f.name === name)
if (!file) { console.error(`There is no kagelet named "${name}". kage list shows them.`); process.exit(1) }
const sp = parseKagelet(name, file.text)
if ('error' in sp) console.log(`${name} does not run: ${sp.error}`)
if (!existsSync(`${DIR}/kage.db`)) { console.log('No runs yet.'); process.exit(0) }
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const now = Date.now()
// A broken file has no lane, so its runs show no cost.
const runs = kageletRuns(name, 'error' in sp ? '' : sp.key, { runs: ledgerText(db, 'runs'), costs: ledgerText(db, 'costs'), reports: ledgerText(db, 'reports') }, now)
if (!runs.length) console.log('No runs yet.')
for (const r of runs.slice(0, 20)) console.log(runLine(r, now))
// The chains it was a step of today (#93). A hub older than the event log has none.
let chains: string[] = []
try { chains = chainViews(eventsOn(db, new Date(now).toISOString().slice(0, 10))).filter(c => c.steps.includes(name)).map(chainLine) } catch {}
for (const c of chains) console.log(`chain ${c}`)
// Its last 20 messages to and from other kagelets, with each one's delivery state.
let messages: ReturnType<typeof kageletMessages> = []
try { messages = kageletMessages(db, name) } catch {}
for (const m of messages) console.log([clockTime(m.at, now).padEnd(16), `${m.from} > ${m.to}`.padEnd(24), m.state.padEnd(10), m.why || m.text.split('\n')[0]!.slice(0, 60)].join(' '))
