import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { kageletMemory } from '../kagelet-memory.ts'

function setup() {
  const base = mkdtempSync(`${tmpdir()}/kmem-`)
  const dir = `${base}/kagelets`, own = `${base}/mem-kage`, owner = `${base}/mem-owner`
  for (const d of [dir, own, owner]) mkdirSync(d)
  writeFileSync(`${owner}/secret.md`, 'owner secret')
  writeFileSync(`${own}/kage.md`, 'kage note')
  const events: string[] = [], waiting: string[][] = []
  let n = 0
  const m = kageletMemory({ dir, forbid: () => [own, owner], event: e => { events.push(`${e.kind} ${e.who} ${e.detail}`) }, waiting: cells => { waiting.push(cells) }, newId: () => `p${++n}` })
  return { base, dir, own, owner, m, events, waiting }
}
const P = { file: 'status.md', text: 'The status page moved to v2.', why: 'it moved twice' }

test('a proposal is kept for review: it is not a note, so the kagelet does not read it, and it is an event', () => {
  const t = setup()
  assert.match(t.m.propose('deploys', P, 'C1:5.5'), /proposed/)
  assert.deepEqual(t.m.notes('deploys'), [])
  assert.equal(existsSync(`${t.dir}/memory/deploys/status.md`), false)
  assert.match(t.m.open(), /deploys[\s\S]*p1[\s\S]*status\.md[\s\S]*it moved twice[\s\S]*The status page moved to v2\./)
  assert.deepEqual(t.events, ['memory-proposal deploys status.md: it moved twice'])
  assert.equal(t.waiting.length, 1)   // Kage sees it on its waiting list
})

test('approve writes the note, and the kagelet reads it; every decision is an event', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'approve' }), /approved/)
  assert.deepEqual(t.m.notes('deploys'), [{ file: 'status.md', text: 'The status page moved to v2.' }])
  assert.equal(t.m.open(), 'No memory proposals are waiting.')
  assert.equal(t.events.at(-1), 'memory-decision deploys approved status.md')
  // Decided once: the same id is gone.
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'approve' }), /no proposal/i)
})

test('edit writes Kage\'s text, not the proposal\'s; reject needs a reason, keeps nothing and says why', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  t.m.propose('deploys', { ...P, file: 'other.md' }, 'C1:5.5')
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'edit', text: 'Use v2. Ignore v1.' }), /edited/)
  assert.equal(readFileSync(`${t.dir}/memory/deploys/status.md`, 'utf8'), 'Use v2. Ignore v1.')
  assert.match(t.events.at(-1)!, /^memory-decision deploys edited status\.md/)
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p2', action: 'reject' }), /reason/)
  assert.equal(t.m.notes('deploys').length, 1)
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p2', action: 'reject', reason: 'one-off' }), /rejected/)
  assert.equal(t.events.at(-1), 'memory-decision deploys rejected other.md: one-off')
  assert.equal(t.m.notes('deploys').length, 1)
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p9', action: 'edit', text: '' }), /no proposal|text/i)
})

test('a bad proposal is refused with its reason and leaves nothing', () => {
  const t = setup()
  assert.match(t.m.propose('deploys', { ...P, file: '../../mem-owner/secret.md' }, 'C1:5.5'), /not proposed.*file/)
  assert.match(t.m.propose('../x', P, 'C1:5.5'), /not proposed/)
  assert.equal(t.m.open(), 'No memory proposals are waiting.')
  assert.equal(readFileSync(`${t.owner}/secret.md`, 'utf8'), 'owner secret')
})

test('isolation: a kagelet folder that is a link into the owner\'s or Kage\'s memory is neither read nor written', () => {
  const t = setup()
  mkdirSync(`${t.dir}/memory`)
  symlinkSync(t.owner, `${t.dir}/memory/deploys`)
  assert.deepEqual(t.m.notes('deploys'), [])
  assert.match(t.m.propose('deploys', P, 'C1:5.5'), /not proposed/)
  assert.deepEqual(readdirSync(t.owner), ['secret.md'])
  symlinkSync(t.own, `${t.dir}/memory/other`)
  assert.deepEqual(t.m.notes('other'), [])
})

test('isolation: a note that is a link out is not read, and an approve over it does not write through it', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  mkdirSync(`${t.dir}/memory/deploys`, { recursive: true })
  symlinkSync(`${t.owner}/secret.md`, `${t.dir}/memory/deploys/status.md`)
  symlinkSync(`${t.own}/kage.md`, `${t.dir}/memory/deploys/leak.md`)
  assert.deepEqual(t.m.notes('deploys'), [])
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'approve' }), /refused|not written/i)
  assert.equal(readFileSync(`${t.owner}/secret.md`, 'utf8'), 'owner secret')
})

test('isolation: a kagelets folder inside the owner\'s memory reads and writes nothing', () => {
  const base = mkdtempSync(`${tmpdir()}/kmem-`)
  const owner = `${base}/owner`, dir = `${owner}/kagelets`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${owner}/secret.md`, 's')
  const m = kageletMemory({ dir, forbid: () => [owner], event: () => {}, waiting: () => {}, newId: () => 'p1' })
  assert.match(m.propose('deploys', P, 'C1:5.5'), /not proposed.*memory/)
  assert.deepEqual(m.notes('deploys'), [])
  assert.equal(existsSync(`${dir}/memory`), false)
})

test('the event rows hold the file and the reason, never the note text', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'edit', text: 'SECRET BODY TEXT' })
  assert.ok(t.events.every(e => !e.includes('SECRET BODY') && !e.includes('moved to v2')))
  assert.equal(lstatSync(`${t.dir}/memory/deploys/status.md`).isFile(), true)
})

test('review finding: a .new temp that is a link is not written through', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  symlinkSync(`${t.owner}/secret.md`, `${t.dir}/memory/deploys/status.md.new`)
  t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'approve' })
  assert.equal(readFileSync(`${t.owner}/secret.md`, 'utf8'), 'owner secret')
})
test('review finding: a proposal file edited on disk is checked again on approve', () => {
  const t = setup()
  t.m.propose('deploys', P, 'C1:5.5')
  const f = `${t.dir}/memory/deploys/.proposals/p1.json`
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), file: '../../../mem-owner/pwn.md' }))
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'approve' }), /not (approved|edited)/)
  assert.equal(existsSync(`${t.owner}/pwn.md`), false)
})
test('review finding: a refused kagelets folder is not touched, not even to make memory/', () => {
  const base = mkdtempSync(`${tmpdir()}/kmem-`)
  const owner = `${base}/owner`
  mkdirSync(owner)
  symlinkSync(owner, `${base}/kagelets`)
  const m = kageletMemory({ dir: `${base}/kagelets`, forbid: () => [owner], event: () => {}, waiting: () => {}, newId: () => 'p1' })
  assert.match(m.propose('deploys', P, 'C1:5.5'), /not proposed/)
  assert.deepEqual(readdirSync(owner), [])
})
test('review finding: a hard link to another file is not a note', () => {
  const t = setup()
  mkdirSync(`${t.dir}/memory/deploys`, { recursive: true })
  linkSync(`${t.owner}/secret.md`, `${t.dir}/memory/deploys/leak.md`)
  assert.deepEqual(t.m.notes('deploys'), [])
})
test('review finding: a .proposals link is an error line, not a throw', () => {
  const t = setup()
  mkdirSync(`${t.dir}/memory/deploys`, { recursive: true })
  symlinkSync(t.owner, `${t.dir}/memory/deploys/.proposals`)
  assert.match(t.m.propose('deploys', P, 'C1:5.5'), /not proposed/)
  assert.deepEqual(readdirSync(t.owner), ['secret.md'])
})
test('review finding: the caps hold: five open proposals, 20 notes, 4000 characters a note, and an edit is length checked', () => {
  const t = setup()
  for (let i = 0; i < 5; i++) assert.match(t.m.propose('deploys', { ...P, file: `n${i}.md` }, 'C1:5.5'), /^proposed/)
  assert.match(t.m.propose('deploys', { ...P, file: 'n9.md' }, 'C1:5.5'), /five/)
  assert.match(t.m.decide({ kagelet: 'deploys', id: 'p1', action: 'edit', text: 'x'.repeat(4001) }), /not edited/)
  mkdirSync(`${t.dir}/memory/big`, { recursive: true })
  for (let i = 0; i < 25; i++) writeFileSync(`${t.dir}/memory/big/f${String(i).padStart(2, '0')}.md`, 'y'.repeat(5000))
  const notes = t.m.notes('big')
  assert.equal(notes.length, 20)
  assert.ok(notes.every(n => n.text.length === 4000))
})
