import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerMemoryRefusal, privateToolRefusal } from './guards.ts'


describe('private sources on a teammate task', () => {
  const MAIL = 'mcp__claude_ai_Gmail__search_threads'
  test('the owner may read mail', () => assert.equal(privateToolRefusal(MAIL, 'owner'), undefined))
  test('a teammate may not read mail, drive, calendar or meeting notes', () => {
    for (const t of [MAIL, 'mcp__claude_ai_Google_Drive__read', 'mcp__claude_ai_Google_Calendar__list', 'mcp__granola__query_granola_meetings', 'mcp__plugin_product-management_fireflies__get'])
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/)
  })
  test('an unknown sender is refused', () => assert.ok(privateToolRefusal(MAIL, undefined)))
  describe("the owner's memory takes only people notes", () => {
    const MEM = '/home/o/.claude/projects/-home-o/memory'
    const ok = (tool: string, file_path: string) => assert.equal(ownerMemoryRefusal(tool, { file_path }, MEM), undefined, `${tool} ${file_path}`)
    const no = (tool: string, file_path: string) => assert.match(ownerMemoryRefusal(tool, { file_path }, MEM) ?? '', /people notes/, `${tool} ${file_path}`)
    test('a note about a person may be written', () => { ok('Write', `${MEM}/user_teammate.md`); ok('Edit', `${MEM}/user_teammate.md`) })
    test('the index may be edited, never overwritten', () => { ok('Edit', `${MEM}/MEMORY.md`); no('Write', `${MEM}/MEMORY.md`) })
    test('any other memory of the owner is read-only', () => {
      no('Write', `${MEM}/feedback_x.md`); no('Edit', `${MEM}/project_y.md`); no('MultiEdit', `${MEM}/sub/user_z.md`)
      no('Write', `${MEM}/../memory/feedback_x.md`)
    })
    test('another spelling of the same folder is still the owner memory: case, ~, a notebook path', () => {
      no('Write', `${MEM.toUpperCase()}/FEEDBACK_X.md`)
      assert.match(ownerMemoryRefusal('Write', { file_path: '~/.claude/projects/-home-o/memory/feedback_x.md' }, MEM, '/home/o') ?? '', /people notes/)
      assert.match(ownerMemoryRefusal('NotebookEdit', { notebook_path: `${MEM}/x.ipynb` }, MEM) ?? '', /people notes/)
    })
    test('a link that points into the owner memory is followed', () => {
      const root = mkdtempSync(join(tmpdir(), 'kage-guard-'))
      const mem = join(root, 'memory')
      mkdirSync(mem)
      writeFileSync(join(mem, 'feedback_x.md'), 'x')
      symlinkSync(join(mem, 'feedback_x.md'), join(root, 'link.md'))
      symlinkSync(mem, join(root, 'dirlink'))
      assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'link.md') }, mem) ?? '', /people notes/)
      assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'new_feedback.md') }, mem) ?? '', /people notes/)
      assert.equal(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'user_bob.md') }, mem), undefined)
    })
    test("Kage's own memory and other files are free, and reads are never blocked", () => {
      ok('Write', '/home/o/.config/kage/memory/feedback_x.md'); ok('Read', `${MEM}/feedback_x.md`); ok('Write', '/tmp/x.md')
    })
  })
  test('other tools are fine for a teammate', () => {
    for (const t of ['Bash', 'Read', 'mcp__kage__reply', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.equal(privateToolRefusal(t, 'teammate'), undefined)
  })
})
