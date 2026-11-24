import { createHash } from 'node:crypto'

type IssueKind = 'bug' | 'idea' | 'feedback'
export type IssueReport = { kind: IssueKind; title: string; what: string; expected: string; steps?: string }
export type IssueSystem = { version: string; system: string }

const REPO = /^[\w.-]+\/[\w.-]+$/
const REMOTE = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

export function repoFromRemote(remote: string, setting?: string): string | undefined {
  if (setting !== undefined) return REPO.test(setting) ? setting : undefined
  return REMOTE.exec(remote.trim())?.[1]
}

const SCRUBS: [RegExp, string][] = [
  [/\b(?:xox[abposr]-[\w-]+|xapp-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16})/g, '[token]'],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [token]'],
  [/<#[A-Z0-9]+(?:\|[^>]*)?>/g, '[channel]'],
  [/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '[person]'],
  [/https?:\/\/[^\s<>|]+/g, '[link]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/(?<![\w-])#(?!\d+\b)[a-z0-9][\w-]*/gi, '[channel]'],
  [/\/(?:Users|home)\/[^/\s]+/g, '~'],
  [/\b[A-Z]:\\(?:Users|home)\\[^\\\s]+/gi, '~'],
  [/\b[UCDGWAT](?=[0-9A-Z]*\d)[0-9A-Z]{8,}\b/g, '[id]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]'],
  [/\+\d{1,3}(?:[\s.-]?\(?\d+\)?){2,5}\d/g, '[number]'],
  [/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[number]'],
  [/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|cloud|internal|local|lan|tech|xyz|uk|in|de|us|eu)\b/gi, '[host]'],
  [/["“][^"”\n]{3,}["”]/g, '[quote]'],
  [/(?<!\w)['‘][^'’\n]{3,}['’](?!\w)/g, '[quote]'],
]

const escaped = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function scrub(text: string, names: string[]): string {
  let out = SCRUBS.reduce((t, [re, to]) => t.replace(re, to), text)
  for (const n of names.filter(n => n.trim().length > 1)) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(n.trim())}(?![\\p{L}\\p{N}_])`, 'giu'), '[name]')
  return out.trim()
}

export function scrubReport(r: IssueReport, names: string[]): IssueReport {
  return { kind: r.kind, title: scrub(r.title, names), what: scrub(r.what, names), expected: scrub(r.expected, names), ...r.steps !== undefined && { steps: scrub(r.steps, names) } }
}

const FINGERPRINT = /^[0-9a-f]{12}$/

export function reportFingerprint(r: IssueReport, crash?: string): string {
  if (crash && FINGERPRINT.test(crash)) return crash
  const words = r.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return createHash('sha256').update(`${r.kind === 'idea' ? 'idea' : 'bug'}\n${words.join(' ')}`).digest('hex').slice(0, 12)
}

const section = (head: string, text: string) => `### ${head}\n\n${text || '_No response_'}`

export function issueBody(r: IssueReport, sys: IssueSystem, fingerprint: string): { labels: string[]; body: string } {
  if (r.kind === 'idea') return { labels: ['idea', 'from-agent'], body: [section('The job', r.what), section('How you would know it works', r.expected), section('Fingerprint', fingerprint)].join('\n\n') }
  return {
    labels: ['bug', 'from-agent'],
    body: [section('Fingerprint', fingerprint), section('What happened', r.what), section('What should have happened', r.expected), section('Steps to see it again', r.steps ?? ''), section('Version and system', `${sys.version} ${sys.system}`)].join('\n\n'),
  }
}

export function issueLink(repo: string, r: IssueReport, sys: IssueSystem, fingerprint: string): string {
  const fields: Record<string, string> = r.kind === 'idea'
    ? { template: 'feature.yml', title: r.title, job: r.what, done: r.expected }
    : { template: 'agent-report.yml', title: r.title, fingerprint, what: r.what, expected: r.expected, ...r.steps && { steps: r.steps }, version: `${sys.version} ${sys.system}` }
  return `https://github.com/${repo}/issues/new?${new URLSearchParams(fields)}`
}

const SENT = ['filed', 'link', 'commented']

export function reportsToday(tsv: string, day: string): number {
  return tsv.split('\n').filter(line => {
    const [at = '', , , outcome = ''] = line.split('\t')
    return at.startsWith(day) && SENT.includes(outcome)
  }).length
}
