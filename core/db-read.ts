
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
