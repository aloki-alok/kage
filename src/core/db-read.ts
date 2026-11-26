import { isOffSlack } from './conversations.ts'
import { senderOf, teammateOf } from './gate.ts'
import { decide, type TrustLine, type TrustMode } from './trust.ts'


const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'ALTER', 'DROP', 'CREATE', 'GRANT', 'REVOKE', 'TRUNCATE', 'COPY', 'CALL', 'DO', 'INTO']

function scan(sql: string): { code: string; run: string } | { refused: string } {
  let code = '', run = '', i = 0
  const keep = (n: number, asCode: (s: string) => string, asRun = (s: string) => s) => {
    const s = sql.slice(i, i + n)
    code += asCode(s); run += asRun(s); i += n
  }
  const blank = (s: string) => ' '.repeat(s.length)
  while (i < sql.length) {
    const c = sql[i]!, two = sql.slice(i, i + 2)
    if (two === '--') {
      const end = sql.indexOf('\n', i)
      keep((end < 0 ? sql.length : end) - i, blank, blank)
    } else if (two === '/*') {
      let depth = 0, j = i
      for (; j < sql.length; j++) {
        if (sql.startsWith('/*', j)) { depth++; j++ } else if (sql.startsWith('*/', j)) { depth--; j++; if (!depth) break }
      }
      if (depth) return { refused: 'an unclosed comment' }
      keep(j + 1 - i, blank, blank)
    } else if (c === "'" || c === '"') {
      let j = i + 1
      for (; j < sql.length; j++) if (sql[j] === c) { if (sql[j + 1] === c) j++; else break }
      if (j >= sql.length) return { refused: `an unclosed ${c === "'" ? 'string' : 'quoted name'}` }
      keep(j + 1 - i, s => c === '"' ? `"${'x'.repeat(s.length - 2)}"` : `'${' '.repeat(s.length - 2)}'`)
    } else keep(1, s => s)
  }
  return { code, run }
}

export function readOnlyQuery(sql: string, maxRows: number): { sql: string } | { refused: string } {
  if (sql.includes('\\')) return { refused: 'a backslash is not allowed: psql runs it as a command' }
  const s = scan(sql)
  if ('refused' in s) return s
  let { code, run } = s
  if (/\$(?!\d)/.test(code)) return { refused: 'dollar quotes ($$ or $tag$) are not allowed' }
  const last = code.trimEnd().length - 1
  if (code[last] === ';') { code = code.slice(0, last); run = run.slice(0, last) }
  if (!code.trim()) return { refused: 'the query is empty' }
  if (code.includes(';')) return { refused: 'one statement only: a semicolon starts a second one' }
  if (!/^\s*(select|with)\b/i.test(code)) return { refused: 'only a read is allowed: the query must start with SELECT or WITH' }
  const bad = FORBIDDEN.find(w => new RegExp(`\\b${w}\\b`, 'i').test(code))
  if (bad) return { refused: `${bad} is not allowed: db_read runs reads only` }
  if (/\bfor\s+(key\s+)?share\b/i.test(code)) return { refused: 'a row lock (FOR SHARE) is not allowed: db_read runs reads only' }
  return { sql: `select * from (\n${run.trim()}\n) as kage_db_read limit ${maxRows}` }
}

type Asker = { fromOwner: boolean; content: string; meta: { channel: string }; source?: string; agent?: { app: string; person?: string }; outsider?: string }
const mayRead = (t: Asker, ownerDm: string) => !(ownerDm && t.meta.channel === ownerDm && !t.fromOwner) && !t.outsider && !isOffSlack(t.meta.channel) && !t.source?.startsWith('meeting:') && !t.agent

type TurnAsker = { reader: boolean; owner: boolean; teammate?: string }
export const turnAskers = (tasks: Asker[], ownerDm: string): TurnAsker[] =>
  tasks.map(t => ({ reader: mayRead(t, ownerDm), owner: senderOf(t) === 'owner', teammate: teammateOf(t.content)?.id }))

type ReadAsk = { turn: TurnAsker[]; owner: boolean; route: string; mode: TrustMode; lines: TrustLine[]; open?: boolean }
type ReadVerdict = { read: true; steps?: { who: string; line: string }[]; would?: string } | { read: false; why: string; would?: string }

const askFor = (route: string) => `Post an ask with the reply tool: waiting_on owner, kind prod-read, reach ${route}. The owner's plain yes saves it for the teammate, and the next read of ${route} goes through.`

export function readGate(a: ReadAsk): ReadVerdict {
  if (a.turn.some(t => !t.reader)) return { read: false, why: 'a meeting, an outsider, another bot, a text, a call and an email read no database, and a turn that holds one of their tasks reads none' }
  if (a.owner) return { read: true }
  const teammates = [...new Set(a.turn.filter(t => !t.owner).map(t => t.teammate))]
  if (!a.turn.length || teammates.some(t => !t)) return { read: false, why: 'only the owner or a listed teammate reads a database' }
  const ds = teammates.map(who => decide(a.lines, { who: who!, kind: 'prod-read', reach: a.route }))
  const would = a.mode === 'off' ? undefined : ds.some(d => d.do === 'no') ? 'no' : ds.every(d => d.do === 'go') ? 'go' : 'ask'
  const no = ds.find(d => d.do === 'no')
  if (a.open && !no) return { read: true }
  if ((a.mode === 'on' || a.open) && no && no.do === 'no') return { read: false, why: `the owner said no to ${a.route} for a teammate in this turn (line ${no.line.id}). Do not read it and do not ask again.`, would }
  if (a.mode === 'on' && ds.length && ds.every(d => d.do === 'go')) return { read: true, steps: ds.flatMap((d, i) => d.do === 'go' ? [{ who: teammates[i]!, line: d.line.id }] : []), would }
  return { read: false, why: `a teammate reads ${a.route} only with the owner's yes, and every teammate in this turn needs one. ${askFor(a.route)}${a.mode === 'on' ? '' : ' Trust is not on, so a yes lets you read only in the turn where the owner answers.'}`, would }
}
