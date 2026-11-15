import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { wordingProblems } from '../core/skill-lessons.ts'

const ROOT = new URL('../skills/', import.meta.url)
const dirs = readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)

test('the plugin ships skills, each named like its folder and each with a description', () => {
  assert.ok(dirs.length >= 4)
  for (const d of dirs) {
    const t = readFileSync(new URL(`${d}/SKILL.md`, ROOT), 'utf8')
    assert.match(t, new RegExp(`^---\\nname: ${d}\\ndescription: .{40,}\\n---\\n`), d)
  }
})
test('a shipped skill holds no name, id, date, quote, email or path', () => {
  for (const d of dirs) assert.deepEqual(wordingProblems(readFileSync(new URL(`${d}/SKILL.md`, ROOT), 'utf8'), []), [], d)
})
