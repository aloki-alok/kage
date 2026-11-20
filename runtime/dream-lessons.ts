import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkDream, type DreamLesson, type DreamLimits } from '../core/dream.ts'
import { oneLine } from '../core/text.ts'

const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const isLink = (f: string) => { try { return lstatSync(f).isSymbolicLink() } catch { return false } }

export function applyLessons(o: { dir: string; chats: Record<string, string>; lessons: DreamLesson[]; limits: DreamLimits; now: number }): { said: string; kept: { new: number; outdated: number } } {
  const { dir } = o
  const iso = new Date(o.now).toISOString()
  const note = (row: string[]) => appendFileSync(join(dir, '.dream-ledger.tsv'), `${[iso, ...row.map(oneLine)].join('\t')}\n`)
  const index = join(dir, 'MEMORY.md')
  const notes = new Set(readdirSync(dir).filter(n => n.endsWith('.md') && read(join(dir, n)).trim()))
  const { kept, dropped } = checkDream(o.lessons, o.chats, o.limits, notes)
  const done: string[] = [], count = { new: 0, outdated: 0 }
  for (const l of kept) {
    const file = join(dir, l.file)
    const sources = [...new Set(l.evidence.map(e => e.key))].join(', ')
    if (isLink(file) || isLink(index) || (l.kind === 'outdated' && isLink(join(dir, '.archive')))) { dropped.push({ lesson: l, why: `${l.file} is a link, not a note` }); continue }
    const listed = (line: string) => line.includes(`](${l.file})`)
    if (l.kind === 'outdated') {
      mkdirSync(join(dir, '.archive'), { recursive: true })
      writeFileSync(join(dir, '.archive', l.file), readFileSync(file))
      writeFileSync(file, '')
      writeFileSync(index, read(index).split('\n').filter(line => !listed(line)).join('\n'))
      note(['outdated', l.file, `${l.text} (from ${sources})`])
    } else {
      const old = read(file), text = l.text.trim()
      if (old.includes(text)) { dropped.push({ lesson: l, why: `${l.file} already says it` }); continue }
      writeFileSync(file, old ? `${old.trimEnd()}\n\n${text}\n` : `${text}\n`)
      if (!read(index).split('\n').some(listed)) appendFileSync(index, `${read(index) && !read(index).endsWith('\n') ? '\n' : ''}- [${l.file.replace(/\.md$/, '')}](${l.file}): ${oneLine(text).slice(0, 150)}\n`)
      note(['new', l.file, `from ${sources}`])
    }
    done.push(l.file)
    count[l.kind]++
  }
  for (const d of dropped) note(['dropped', d.lesson.file, d.why])
  return { kept: count, said: [`kept ${done.length}${done.length ? `: ${done.join(', ')}` : ''}`, `dropped ${dropped.length}${dropped.length ? `: ${dropped.map(d => `${d.lesson.file} (${d.why})`).join('; ')}` : ''}`].join('\n') }
}
