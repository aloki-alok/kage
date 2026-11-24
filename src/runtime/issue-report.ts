import { execFile } from 'node:child_process'
import { issueBody, reportFingerprint, repoFromRemote, type IssueReport } from '../core/issue-report.ts'
import type { SessionReport } from './tools/report-tools.ts'

type Run = (cmd: string, args: string[], input?: string) => Promise<string>

const run: Run = (cmd, args, input) => new Promise((ok, no) => {
  const p = execFile(cmd, args, { timeout: 30_000 }, (e, out) => e ? no(e) : ok(out))
  if (input !== undefined) p.stdin?.end(input)
})

export function issueReporter(o: { code: string; repo?: string; version: () => string; perDay: number; names: () => string[]; redact?: string[] }, sh: Run = run): SessionReport {
  return {
    repo: async () => repoFromRemote(await sh('git', ['-C', o.code, 'remote', 'get-url', 'origin']).catch(() => ''), o.repo),
    file: async (repo, title, body, labels) => (await sh('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-', ...labels.flatMap(l => ['--label', l])], body)).trim(),
    find: async (repo, fingerprint) => {
      const [hit] = JSON.parse(await sh('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--search', `"${fingerprint}" in:body`, '--json', 'number,url', '--limit', '1'])) as { number: number; url: string }[]
      return hit && { number: hit.number, url: hit.url }
    },
    comment: async (repo, number, body) => { await sh('gh', ['issue', 'comment', String(number), '--repo', repo, '--body-file', '-'], body) },
    get system() { return { version: o.version(), system: `${process.platform} ${process.arch}` } },
    perDay: o.perDay,
    names: o.names,
    redact: () => o.redact ?? [],
  }
}

export async function fileFound(r: Omit<SessionReport, 'names'>, report: IssueReport): Promise<{ outcome: string; repo: string; url: string }> {
  const repo = await r.repo()
  if (!repo) return { outcome: 'no repo', repo: '', url: '' }
  const fingerprint = reportFingerprint(report), hit = await r.find(repo, fingerprint)
  if (hit) {
    await r.comment(repo, hit.number, `seen again on ${r.system.version} ${r.system.system}`)
    return { outcome: 'commented', repo, url: hit.url }
  }
  const { labels, body } = issueBody(report, r.system, fingerprint)
  return { outcome: 'filed', repo, url: await r.file(repo, report.title, body, labels) }
}
