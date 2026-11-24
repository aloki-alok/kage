import { z } from 'zod'
import { issueBody, issueLink, reportFingerprint, reportsToday, scrubReport, type IssueReport, type IssueSystem } from '../../core/issue-report.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'

export type SessionReport = {
  repo(): Promise<string | undefined>
  file(repo: string, title: string, body: string, labels: string[]): Promise<string>
  find(repo: string, fingerprint: string): Promise<{ number: number; url: string } | undefined>
  comment(repo: string, number: number, body: string): Promise<void>
  system: IssueSystem
  perDay: number
  names?: () => string[]
}

const MAX_BODY = 2000

const namesOf = (c: ToolContext, r: SessionReport) => {
  const known = [...Object.values(c.names), ...[...c.askers.values()].flatMap(a => a ? [a.name] : []), ...r.names?.() ?? []]
  return [...new Set(known.flatMap(n => [n, ...n.split(/\s+/)]))]
}

type Args = IssueReport & { channel: string; thread_ts: string; fingerprint?: string }
type Log = (outcome: string, repo?: string, url?: string) => void

async function seenAgain(c: ToolContext, r: SessionReport, log: Log, repo: string, kind: string, hit: { number: number; url: string }): Promise<Result> {
  const text = `seen again on ${r.system.version} ${r.system.system}`
  if (!await c.o.approve!('report_issue', `This matches #${hit.number} on ${repo}, still open: ${hit.url}\nAdd one comment to it instead of a new issue:\n${text}`, { repo, issue: hit.number, body: text })) {
    log('denied', repo)
    return { isError: true, text: 'The owner said no. Nothing was sent.' }
  }
  try { await r.comment(repo, hit.number, text) } catch {
    log('failed', repo, hit.url)
    return { isError: true, text: `gh could not add the comment, so nothing was sent. It is already filed: ${hit.url}. Post that link in the thread in one line.` }
  }
  log('commented', repo, hit.url)
  c.o.event?.('tool', `report_issue ${kind} seen again`)
  return { text: `Already filed as ${hit.url}, so it got a seen again comment instead. Post this link in the thread in one line.` }
}

async function report(c: ToolContext, r: SessionReport, a: Args): Promise<Result> {
  const key = `${a.channel}:${a.thread_ts}`, log: Log = (outcome, repo = '', url = '') => c.append('issue-reports', [key, a.kind, outcome, repo, url])
  if (!c.ownerTask.has(key) || c.agents.get(key) || a.channel === 'voice') return { isError: true, text: "refused: an agent's task or a voice call never files an issue" }
  if (!c.o.approve) return { isError: true, text: 'refused: filing needs the owner\'s yes on a card, and this session cannot show one' }
  if (reportsToday(c.ledger('issue-reports'), new Date().toISOString().slice(0, 10)) >= r.perDay) { log('capped'); return { isError: true, text: `refused: this install files at most ${r.perDay} a day (report.perDay)` } }
  const repo = await r.repo()
  if (!repo) return { isError: true, text: 'refused: no GitHub repo found for this Kage checkout. Set report.repo.' }
  const clean = scrubReport(a, namesOf(c, r)), fingerprint = reportFingerprint(clean, a.fingerprint), { labels, body } = issueBody(clean, r.system, fingerprint)
  if (body.length > MAX_BODY) return { isError: true, text: `refused: the body is ${body.length} characters. Shorten it to under ${MAX_BODY}, so the owner's card shows all of it.` }
  const hit = await r.find(repo, fingerprint).catch(() => undefined)
  if (hit) return seenAgain(c, r, log, repo, clean.kind, hit)
  if (!await c.o.approve('report_issue', `File this ${clean.kind} to ${repo}. It holds only what you see here.\n*${clean.title}*\n${body}`, { repo, title: clean.title, body })) {
    log('denied', repo)
    return { isError: true, text: 'The owner said no. Nothing was sent.' }
  }
  try {
    const url = await r.file(repo, clean.title, body, labels)
    log('filed', repo, url)
    c.o.event?.('tool', `report_issue ${clean.kind} filed`)
    return { text: `Filed: ${url}. Post this link in the thread in one line.` }
  } catch {
    const link = issueLink(repo, clean, r.system, fingerprint)
    log('link', repo)
    c.o.event?.('tool', `report_issue ${clean.kind} link`)
    return { text: `gh could not file it here. Post this link in the thread in one line, for the owner to open and submit: ${link}` }
  }
}

export function reportTools(c: ToolContext): KageTool[] {
  const r = c.o.report
  if (!r || c.name || c.o.dreaming || c.o.dreamLessons) return []
  return [{
    name: 'report_issue',
    description: "File a bug, an idea or feedback about Kage itself to Kage's GitHub repo. The hub removes names, ids, emails, paths and quotes, and the owner sees the exact text on a card before anything is sent.",
    shape: {
      channel: c.s.describe('channel attribute from the task tag'),
      thread_ts: c.s.describe('thread_ts attribute from the task tag'),
      kind: z.enum(['bug', 'idea', 'feedback']),
      title: c.s.describe('one line, what goes wrong or what Kage should do'),
      what: c.s.describe('a bug: what happened. An idea: the job done by hand today'),
      expected: c.s.describe('a bug: what should have happened. An idea: how you would know it works'),
      steps: c.s.optional().describe('a bug: the steps to see it again'),
      fingerprint: c.s.optional().describe('a crash: the 12 character fingerprint from kage logs, so repeats land on one issue'),
    },
    run: args => report(c, r, args as Args),
  }]
}
