// kage logs <kagelet>: its last 20 runs, newest first: time, cost, ok or failed, and its report.
// It reads the files and the ledgers, so it works with the hub down.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DIR } from './home.ts'
import { parseKagelet } from '../core/kagelets.ts'
import { clockTime } from '../core/board.ts'
import { kageletRuns, runLine } from '../core/kagelet-view.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets.ts'
import { ledgerText } from '../runtime/ledger.ts'

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
// Its grants: who approved each db_read, a card or the standing approval (#96), and any revoke.
const grants = ledgerText(db, 'grants').split('\n').filter(l => l.split('\t')[1] === name).slice(-5)
if (grants.length) console.log(`\nGrants:\n${grants.map(l => { const [at = '', , what = '', why = ''] = l.split('\t'); return `${clockTime(Date.parse(at), now).padEnd(16)} ${what}: ${why}` }).join('\n')}`)
