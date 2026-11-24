import { isOffSlack } from './conversations.ts'

const OUTSIDE_THE_TRANSACTION = /(?:^|[^\w$])(dblink\w*|lo_\w+|pg_(?:terminate|cancel)_backend|pg_read_(?:binary_)?file|pg_ls_\w+|pg_stat_file|pg_file_\w+|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication_origin_\w+|pg_logical_emit_message|pg_advisory\w*|pg_notify|pg_sleep\w*|set_config)\s*\(/i
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
  const outside = OUTSIDE_THE_TRANSACTION.exec(code)?.[1]
  if (outside) return { refused: `${outside} is not allowed: it acts outside the read-only transaction` }
  if (/"\s*\(/.test(code)) return { refused: 'a quoted function name is not allowed: call functions by their plain name' }
  if (/\bfor\s+(key\s+)?share\b/i.test(code)) return { refused: 'a row lock (FOR SHARE) is not allowed: db_read runs reads only' }
  return { sql: `select * from (\n${run.trim()}\n) as kage_db_read limit ${maxRows}` }
}

export const routeFolders = (routes: Record<string, string>, home: string) =>
  [...new Set(Object.values(routes).flatMap(c => c.split(/\s+/)).filter(w => /^(\/|~\/)/.test(w)).map(w => dirOf(w.replace(/^~(?=\/)/, home))))]
const dirOf = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf('/')))

type Asker = { meta: { channel: string }; source?: string; agent?: { person?: string }; outsider?: string }
export const mayReadDb = (t: Asker) => !t.outsider && !isOffSlack(t.meta.channel) && !t.source?.startsWith('meeting:') && !(t.agent && !t.agent.person)
