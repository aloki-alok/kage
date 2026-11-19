import { readFileSync, writeFileSync } from 'node:fs'
import { DIR } from './home.ts'
import { awayFacts, awayLines, awaySince } from '../core/away.ts'
import { kageletRows } from '../core/kagelets.ts'
import { FOX, MARK } from '../core/voice.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelet-files.ts'
import { voice } from './voice.ts'

const up = process.argv[2] === 'up'
const now = Date.now()
const read = (f: string) => { try { return readFileSync(`${DIR}/${f}`, 'utf8').trim() } catch { return undefined } }
const since = awaySince(read('last-seen'), now)
const ledgers = openLedgers(DIR)
const days = Array.from({ length: Math.ceil((now - since) / 86_400_000) + 1 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10))
const kagelets = kageletRows(readKagelets(kageletsDir(DIR)), { runs: ledgers.text('runs'), costs: ledgers.text('costs'), now })
const away = awayLines(awayFacts({
  posted: ledgers.text('posted'), costs: ledgers.text('costs'), runs: ledgers.text('runs'), waiting: ledgers.text('waiting'),
  events: days.flatMap(d => ledgers.events(d)), kagelets, since, now,
}))

const version = read('version')?.split(' ')[0]
const right = [
  '',
  `${voice.fire(MARK.kage)} ${up ? "I'm out and working." : "I'm gone to ground (not running)."}${version ? ` ${voice.dim(version)}` : ''}`,
  '',
  away.head,
  ...away.did.map(d => `  ${voice.fire(MARK.working)} ${d}`),
  ...away.needsYou.length ? ['', ...away.needsYou.map(n => `  ${voice.needsYou(n)}`)] : [],
  '',
  voice.dim([away.tails, up ? 'kage top to watch me' : undefined].filter(Boolean).join(' · ')),
  up ? voice.dim('kage help for everything else') : `${voice.dim('Wake me:')} ${voice.command('kage start')}`,
]

const wide = Boolean(process.stdout.isTTY) && (process.stdout.columns ?? 0) >= 80
if (wide) {
  const art = FOX.map(l => voice.fire(l))
  const pad = ' '.repeat([...FOX[0]!].length)
  for (let i = 0; i < Math.max(art.length, right.length); i++) console.log(`${art[i] ?? pad}   ${right[i] ?? ''}`.trimEnd())
} else for (const line of right.slice(1)) console.log(line)

try { writeFileSync(`${DIR}/last-seen`, String(now)) } catch {}
