import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { grantRefusal, parseSpecialist } from './specialists.ts'

const file = (head: string, body = 'Post a summary of the deploy log.') => `---\n${head}\n---\n${body}\n`
const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'

describe('a specialist file', () => {
  test('gives its thread lane, schedule, grant and job', () => {
    assert.deepEqual(parseSpecialist('deploys', file(`thread: ${LINK}\nschedule: 0 9 * * 1-5\ntools: Read, Grep,WebFetch`)), {
      name: 'deploys', key: 'CTEST1:1700000000.123456#side-spec-deploys', cron: '0 9 * * 1-5', tools: ['Read', 'Grep', 'WebFetch'], job: 'Post a summary of the deploy log.',
    })
  })
  test('no tools line grants no tools', () => {
    assert.deepEqual((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { tools: string[] }).tools, [])
  })
  test('a wrong file says what is wrong, and runs nothing', () => {
    assert.match((parseSpecialist('x', 'just text') as { error: string }).error, /front matter/)
    assert.match((parseSpecialist('x', file('schedule: 0 9 * * *')) as { error: string }).error, /thread/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}`)) as { error: string }).error, /schedule/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}\nschedule: every day`)) as { error: string }).error, /schedule/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`, '  ')) as { error: string }).error, /job/)
    assert.match((parseSpecialist('Bad Name', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { error: string }).error, /name/)
  })
})

describe('the grant', () => {
  test('a tool outside the grant is refused; Kage\'s own tools for its thread are always there', () => {
    assert.equal(grantRefusal('Read', ['Read']), undefined)
    assert.match(grantRefusal('Bash', ['Read']) ?? '', /grant/)
    assert.equal(grantRefusal('mcp__kage__reply', []), undefined)
    assert.match(grantRefusal('mcp__other__thing', []) ?? '', /grant/)
    // Only the tools for its own thread: never the ones that act as the owner or outlive the run.
    for (const t of ['mcp__kage__message_people', 'mcp__kage__schedule', 'mcp__kage__away', 'mcp__kage__send_file', 'mcp__kage__set_model', 'mcp__kage__log_prod_write'])
      assert.match(grantRefusal(t, []) ?? '', /grant/, t)
    for (const t of ['mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__kage__delete_message']) assert.equal(grantRefusal(t, []), undefined, t)
  })
  test('it can never widen its own grant or read secrets: no shell, no writes, no reads in Kage\'s config folder', () => {
    const conf = mkdtempSync(join(tmpdir(), 'kage-conf-'))
    const work = mkdtempSync(join(tmpdir(), 'kage-work-'))
    symlinkSync(conf, join(work, 'link'))
    assert.match(grantRefusal('Bash', ['Bash']) ?? '', /shell/)
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.match(grantRefusal(t, [t], { file_path: join(work, 'out.md') }, conf) ?? '', /write/, t)
    assert.match(grantRefusal('Read', ['Read'], { file_path: join(conf, 'env') }, conf) ?? '', /config/)
    assert.match(grantRefusal('Read', ['Read'], { file_path: join(work, '..', basename(conf), 'env') }, conf) ?? '', /config/)
    assert.match(grantRefusal('Read', ['Read'], { file_path: join(work, 'link', 'env') }, conf) ?? '', /config/)
    assert.match(grantRefusal('Grep', ['Grep'], { pattern: 'x' }, conf) ?? '', /config/)          // no path: the work folder, which may hold it
    assert.match(grantRefusal('Grep', ['Grep'], { pattern: 'x', path: dirname(conf) }, conf) ?? '', /config/)
    assert.equal(grantRefusal('Read', ['Read'], { file_path: join(work, 'notes.md') }, conf), undefined)
    assert.equal(grantRefusal('Grep', ['Grep'], { pattern: 'x', path: work }, conf), undefined)
  })
})
