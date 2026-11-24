import { execFile } from 'node:child_process'
import { applyFixes, report, stillFixed, type Line } from '../../core/doctor.ts'
import { name } from './context.ts'
import { setup } from './setup.ts'
import { session } from './session.ts'
import { service } from './service.ts'
import { slack } from './slack.ts'
import { update } from './update.ts'
import { browser } from './browser.ts'
import { path } from './path.ts'
import { scopes } from './scopes.ts'
import { whatsapp } from './whatsapp.ts'
import { leftovers } from './leftovers.ts'
import { tunnel } from './tunnel.ts'
import { connect } from './connect.ts'
import { runners } from './runners.ts'

const skip = process.argv.find(a => a.startsWith('--skip='))?.slice(7).split(',') ?? []
const check = async () => {
  const lines: Line[] = []
  for (const [group, run] of Object.entries({ setup, session, service, slack, update, connect, browser, whatsapp, tunnel, path, scopes, runners, leftovers }).filter(([g]) => !skip.includes(g))) {
    try { lines.push(...await run()) } catch (e) { lines.push({ kind: 'fail', text: `${group}: the check did not run (${(e as Error).message})` }) }
  }
  return lines
}
const lines = await check()
const fixed = process.argv.includes('--fix') ? await applyFixes(lines, argv => new Promise(ok => execFile(argv[0]!, argv.slice(1), { timeout: 20_000 }, e => ok(!e)))) : lines
const final = fixed.some(l => l.kind === 'fixed') ? stillFixed(fixed, await check()) : fixed
const r = report(final, name)
console.log(r.text)
process.exit(r.ok ? 0 : 1)
