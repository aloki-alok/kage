// kage doctor: runs each check group in order and prints the lines (core/doctor.ts). Exit 1 when any check fails.
// A group that throws is one FAIL line, so the rest still run.
import { report, type Line } from '../../core/doctor.ts'
import { name } from './context.ts'
import { setup } from './setup.ts'
import { session } from './session.ts'
import { service } from './service.ts'
import { slack } from './slack.ts'
import { update } from './update.ts'
import { browser } from './browser.ts'
import { path } from './path.ts'
import { scopes } from './scopes.ts'

const lines: Line[] = []
for (const [group, run] of Object.entries({ setup, session, service, slack, update, browser, path, scopes })) {
  try { lines.push(...await run()) } catch (e) { lines.push({ kind: 'fail', text: `${group}: the check did not run (${(e as Error).message})` }) }
}
const r = report(lines, name)
console.log(r.text)
process.exit(r.ok ? 0 : 1)
