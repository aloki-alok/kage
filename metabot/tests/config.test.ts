import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, readJobAndPack } from '../config.ts'

describe("the bot's settings", () => {
  test('nothing set means dry: the bot never sends until someone chooses team or live', () => {
    const c = parseConfig({}, '/d')
    assert.equal(c.settings.mode, 'dry')
    assert.equal(c.settings.limits.repliesPerLeadPerDay, 8)
    assert.equal(c.packDir, '/d/pack')
  })

  test('team and live need our app id, or the bot runs dry', () => {
    assert.equal(parseConfig({ mode: 'live' }, '/d').settings.mode, 'dry')
    assert.equal(parseConfig({ mode: 'team', ourAppId: '' }, '/d').settings.mode, 'dry')
    assert.equal(parseConfig({ mode: 'live', ourAppId: 'APP' }, '/d').settings.mode, 'live')
    assert.equal(parseConfig({ mode: 'off' }, '/d').settings.mode, 'off')
    assert.equal(parseConfig({ mode: 'live', ourAppId: ' ' }, '/d').settings.mode, 'dry')
  })

  test('a wrong value falls back to its default, never to something looser', () => {
    const c = parseConfig({ mode: 'yolo', limits: { repliesPerLeadPerDay: -1, humanQuietHours: 'x' }, maxChars: 5, team: ['T1', 3] }, '/d')
    assert.equal(c.settings.mode, 'dry')
    assert.deepEqual(c.settings.limits, { repliesPerLeadPerDay: 8, humanQuietHours: 72 })
    assert.equal(c.settings.maxChars, 600)
    assert.deepEqual(c.settings.team, ['T1'])
  })

  test('the pack is every .md file, and links.md holds the links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-'))
    mkdirSync(join(dir, 'pack'))
    writeFileSync(join(dir, 'job.md'), 'Be kind.')
    writeFileSync(join(dir, 'pack', 'b-pricing.md'), 'Plans start at $10.')
    writeFileSync(join(dir, 'pack', 'a-product.md'), 'We build voice agents.')
    writeFileSync(join(dir, 'pack', 'links.md'), '# Links\n- https://www.acme-shop.com/pricing  # pricing\nnot a link\n\n# https://commented.out\n')
    const r = readJobAndPack(dir, join(dir, 'pack'))
    assert.equal(r.job, 'Be kind.')
    assert.equal(r.pack.facts, 'We build voice agents.\n\nPlans start at $10.')
    assert.deepEqual(r.pack.links, ['https://www.acme-shop.com/pricing'])
  })

  test('a missing folder gives an empty pack, not a crash', () => {
    assert.deepEqual(readJobAndPack('/nope', '/nope/pack'), { job: '', pack: { facts: '', links: [] } })
  })
})
