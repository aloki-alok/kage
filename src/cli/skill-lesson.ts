import { readFileSync } from 'node:fs'
import { wordingProblems } from '../core/skill-lessons.ts'

const [file, ...names] = process.argv.slice(2)
if (!file) { console.error('usage: node cli/skill-lesson.ts <file> [name...]'); process.exit(2) }
const problems = wordingProblems(readFileSync(file, 'utf8'), names)
if (problems.length) { console.error(`not generic: ${problems.join(', ')}`); process.exit(1) }
console.error('ok: generic')
