// Stage 1: run saved threads through the whole pipeline with the real model and guard, in dry mode, with an
// in-memory store and no sink. Nothing is sent. Prints each lead line with the outcome, the label and the draft.
//   node metabot/replay.ts <threads.json> [bot folder]
// threads.json: [{ "id": "T1", "lines": ["first lead message", "second"] }, ...]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadSecrets, readJobAndPack } from './config.ts'
import { chat } from './model.ts'
import { handle } from './reply.ts'
import { openStore } from './store.ts'

const [file, dir = process.env.METABOT_DIR || join(homedir(), '.config', 'kage', 'metabot')] = process.argv.slice(2)
if (!file) { process.stderr.write('Usage: node metabot/replay.ts <threads.json> [bot folder]\n'); process.exit(1) }
const threads = JSON.parse(readFileSync(file, 'utf8')) as { id: string; lines: string[] }[]
const cfg = loadConfig(dir), key = loadSecrets(dir).modelKey || process.env.OPENAI_API_KEY || ''
if (!key) { process.stderr.write('No model key: set modelKey in secrets.json or OPENAI_API_KEY\n'); process.exit(1) }

const store = openStore(':memory:')
let clock = Date.now()
const counts: Record<string, number> = {}
for (const t of threads) {
  process.stdout.write(`\n## ${t.id}\n`)
  for (const [i, text] of t.lines.entries()) {
    const ev = { kind: 'message' as const, channel: 'messenger' as const, pageId: 'replay', user: t.id, id: `${t.id}-${i}`, text, at: clock += 1000 }
    const outcome = await handle(ev, {
      store, now: () => clock, settings: { ...cfg.settings, mode: 'dry' },
      read: () => readJobAndPack(dir, cfg.packDir),
      model: (m, json) => chat(cfg.model, key, m, json),
      send: async () => { throw new Error('replay never sends') },
      missed: q => process.stdout.write(`   missed: ${q}\n`),
    })
    counts[outcome] = (counts[outcome] ?? 0) + 1
    const draft = store.drafts(1)[0]
    process.stdout.write(`LEAD  ${text.replace(/\s+/g, ' ').slice(0, 160)}\n${outcome.padEnd(5)} ${draft && draft.key.endsWith(`:${t.id}`) ? draft.text.replace(/\s+/g, ' ') : ''}\n`)
    // The draft is not a sent line, so the next turn would not see it: add it as the bot's line for a realistic replay.
    if (outcome === 'drafted' && draft) store.addLine(`messenger:replay:${t.id}`, clock, 'bot', draft.text.replace(/^\[[a-z_]+\] /, ''))
  }
}
process.stdout.write(`\nOutcomes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}\n`)
