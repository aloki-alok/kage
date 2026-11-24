import { execFile } from 'node:child_process'
import { doctorWatch, runDoctor } from '../runtime/doctor-watch.ts'
import { fileFound } from '../runtime/issue-report.ts'
import { canPushToKage } from '../runtime/repo-access.ts'
import { log } from '../runtime/log.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'
import type { SessionReport } from '../runtime/tools/report-tools.ts'

export function selfCheck(o: { code: string; store: Store; ledgers: Ledgers; say: (text: string) => Promise<boolean>; reporter?: SessionReport }) {
  const ownsKage = canPushToKage(args => new Promise((ok, no) => execFile('gh', args, { timeout: 15_000 }, (e, out) => e ? no(e) : ok(out))))
  const reporter = o.reporter
  const doctor = doctorWatch({ run: runDoctor(o.code), store: o.store, say: o.say, event: detail => o.ledgers.event({ kind: 'doctor', who: 'hub', trace: '', detail }),
    ...reporter && { file: async r => { if (!await ownsKage) return; const f = await fileFound(reporter, r); o.ledgers.add('issue-reports', ['doctor', r.kind, f.outcome, f.repo, f.url]) } } })
  setTimeout(() => void doctor().catch(e => log('doctor check failed', e)), 5 * 60_000).unref()
  return doctor
}
