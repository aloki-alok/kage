// db_read: the statement check a kagelet's query passes before the owner's read command runs it. PostgreSQL
// syntax. It is the second wall: the first is the read-only access the owner's command already has. It reads
// statements, not functions: nextval, set_config, lo_import, dblink_exec and the like pass, and only that access stops them.
// Fails closed: whatever this reader and the database could read two ways (backslash escapes, dollar
// quotes) is refused, not guessed at.

const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'ALTER', 'DROP', 'CREATE', 'GRANT', 'REVOKE', 'TRUNCATE', 'COPY', 'CALL', 'DO', 'INTO']

// The query as code (strings and quoted names blanked, so their words are not keywords) and as it will run
// (comments blanked). Both keep the input's length, so a place in one is the same place in the other.
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
      // PostgreSQL nests block comments.
      let depth = 0, j = i
      for (; j < sql.length; j++) {
        if (sql.startsWith('/*', j)) { depth++; j++ } else if (sql.startsWith('*/', j)) { depth--; j++; if (!depth) break }
      }
      if (depth) return { refused: 'an unclosed comment' }
      keep(j + 1 - i, blank, blank)
    } else if (c === "'" || c === '"') {
      // '' or "" inside is the quote itself.
      let j = i + 1
      for (; j < sql.length; j++) if (sql[j] === c) { if (sql[j + 1] === c) j++; else break }
      if (j >= sql.length) return { refused: `an unclosed ${c === "'" ? 'string' : 'quoted name'}` }
      keep(j + 1 - i, s => c === '"' ? `"${'x'.repeat(s.length - 2)}"` : `'${' '.repeat(s.length - 2)}'`)
    } else keep(1, s => s)
  }
  return { code, run }
}

// The query that runs, capped at maxRows, or why it is refused.
export function readOnlyQuery(sql: string, maxRows: number): { sql: string } | { refused: string } {
  // psql runs a backslash outside a string as its own command (\! runs a shell), and inside a string a
  // backslash is an escape or not depending on the database's settings.
  if (sql.includes('\\')) return { refused: 'a backslash is not allowed: psql runs it as a command' }
  const s = scan(sql)
  if ('refused' in s) return s
  let { code, run } = s
  // Any dollar but a $1 parameter: a tag may hold letters of any alphabet ($é$), so none is guessed at.
  if (/\$(?!\d)/.test(code)) return { refused: 'dollar quotes ($$ or $tag$) are not allowed' }
  // One trailing semicolon ends the statement; any other starts a second one.
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
