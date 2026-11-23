import { execFile } from 'node:child_process'
import { repoFromRemote } from '../core/issue-report.ts'
import type { SessionReport } from './tools/report-tools.ts'

type Run = (cmd: string, args: string[], input?: string) => Promise<string>

const run: Run = (cmd, args, input) => new Promise((ok, no) => {
  const p = execFile(cmd, args, { timeout: 30_000 }, (e, out) => e ? no(e) : ok(out))
  if (input !== undefined) p.stdin?.end(input)
})

export function issueReporter(o: { code: string; repo?: string; version: () => string; perDay: number; names: () => string[] }, sh: Run = run): SessionReport {
  return {
    repo: async () => repoFromRemote(await sh('git', ['-C', o.code, 'remote', 'get-url', 'origin']).catch(() => ''), o.repo),
    file: async (repo, title, body, labels) => (await sh('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-', ...labels.flatMap(l => ['--label', l])], body)).trim(),
    get system() { return { version: o.version(), system: `${process.platform} ${process.arch}` } },
    perDay: o.perDay,
    names: o.names,
  }
}
