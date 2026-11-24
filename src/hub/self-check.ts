import { execFile } from 'node:child_process'
import { doctorWatch, failureWatch, runDoctor } from '../runtime/doctor-watch.ts'
import { fileFound } from '../runtime/issue-report.ts'
import { canPushToKage } from '../runtime/repo-access.ts'
import { reportsToday } from '../core/issue-report.ts'
import { log } from '../runtime/log.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'
import type { SessionReport } from '../runtime/tools/report-tools.ts'

const gh = (args: string[]) => new Promise<string>((ok, no) => execFile('gh', args, { timeout: 15_000 }, (e, out) => e ? no(e) : ok(out)))

export function selfCheck(o: { code: string; store: Store; ledgers: Ledgers; say: (text: string) => Promise<boolean>; reporter?: SessionReport; failureRepeats: number }) {
  const reporter = o.reporter
  const doctor = doctorWatch({ run: runDoctor(o.code), store: o.store, say: o.say, event: detail => o.ledgers.event({ kind: 'doctor', who: 'hub', trace: '', detail }),
    canFile: () => canPushToKage(gh),
    ...reporter && { file: async r => {
      if (reportsToday(o.ledgers.text('issue-reports'), new Date().toISOString().slice(0, 10)) >= reporter.perDay) { o.ledgers.add('issue-reports', ['doctor', r.kind, 'capped', '', '']); throw new Error('capped') }
      const f = await fileFound(reporter, r)
      o.ledgers.add('issue-reports', ['doctor', r.kind, f.outcome, f.repo, f.url])
      if (f.outcome === 'no repo') throw new Error('no repo')
    } } })
  setTimeout(() => void doctor().catch(e => log('doctor check failed', e)), 5 * 60_000).unref()
  const today = () => new Date().toISOString().slice(0, 10)
  const failures = failureWatch({ store: o.store, say: o.say, events: () => o.ledgers.events(today()), day: today, atLeast: () => o.failureRepeats })
  return async () => { await failures(); await doctor() }
}
