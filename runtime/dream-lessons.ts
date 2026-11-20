import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkDream, type DreamLesson, type DreamLimits } from '../core/dream.ts'
import { oneLine } from '../core/text.ts'

const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

export function applyLessons(o: { dir: string; chats: Record<string, string>; lessons: DreamLesson[]; limits: DreamLimits; now: number }): string {
  const { dir } = o
  const iso = new Date(o.now).toISOString()
  const note = (row: string[]) => appendFileSync(join(dir, '.dream-ledger.tsv'), `${[iso, ...row.map(oneLine)].join('\t')}\n`)
  const index = join(dir, 'MEMORY.md')
  const { kept, dropped } = checkDream(o.lessons, o.chats, o.limits)
  const done: string[] = []
  for (const l of kept) {
    const file = join(dir, l.file)
    const sources = [...new Set(l.evidence.map(e => e.key))].join(', ')
    if (l.kind === 'outdated') {
      if (!existsSync(file)) { dropped.push({ lesson: l, why: `no note named ${l.file}` }); continue }
      mkdirSync(join(dir, '.archive'), { recursive: true })
      writeFileSync(join(dir, '.archive', l.file), readFileSync(file))
      writeFileSync(file, '')
      writeFileSync(index, read(index).split('\n').filter(line => !line.includes(`(${l.file})`)).join('\n'))
      note(['outdated', l.file, `${l.text} (from ${sources})`])
    } else {
      const old = read(file)
      writeFileSync(file, old ? `${old.trimEnd()}\n\n${l.text.trim()}\n` : `${l.text.trim()}\n`)
      if (!read(index).includes(`(${l.file})`)) appendFileSync(index, `${read(index) && !read(index).endsWith('\n') ? '\n' : ''}- [${l.file.replace(/\.md$/, '')}](${l.file}): ${oneLine(l.text).slice(0, 150)}\n`)
      note(['new', l.file, `from ${sources}`])
    }
    done.push(l.file)
  }
  for (const d of dropped) note(['dropped', d.lesson.file, d.why])
  return [`kept ${done.length}${done.length ? `: ${done.join(', ')}` : ''}`, `dropped ${dropped.length}${dropped.length ? `: ${dropped.map(d => `${d.lesson.file} (${d.why})`).join('; ')}` : ''}`].join('\n')
}
