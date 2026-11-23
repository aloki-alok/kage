import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { jevConfig, REACTIONS, reactionVerdict, triageRequest, triageSkips, triageVerdict } from '../core/jev.ts'
import { envFilePath, readSettings } from '../runtime/config-files.ts'

const { config, secrets } = readSettings(envFilePath())
const c = jevConfig(config.jev, process.env.TYPESAFE_AI_KEY || secrets.jevKey)
if (!c || 'error' in c) throw new Error('Configure Jev or set TYPESAFE_AI_KEY before calibration')
const data = JSON.parse(readFileSync(new URL('../core/tests/data/reaction-eval.json', import.meta.url), 'utf8')) as {
  cases: { message: string; context: string; acceptable: (string | null)[] }[]
}
const fingerprint = createHash('sha256').update(JSON.stringify({ questions: triageRequest('', c.model).questions, reactions: REACTIONS })).digest('hex').slice(0, 16)
const runs = []
for (let run = 1; run <= 3; run++) {
  const tally = { correct: 0, wrong_emoji: 0, reacted_when_it_should_not: 0, missed: 0, errors: 0 }
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < data.cases.length) {
      const index = next++, sample = data.cases[index]!
      try {
        const response = await fetch(c.url, {
          method: 'POST', headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(triageRequest(sample.message, c.model, sample.context)), signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        const got = reactionVerdict(body)
        if (!Object.hasOwn(body.answers ?? {}, 'reaction')) throw new Error('missing answer')
        const verdict = triageVerdict(body, 'other')
        if ('error' in verdict) throw new Error('missing intake answer')
        const emoji = triageSkips(sample.message, { hasFiles: false, inThread: false }) || verdict.pick === 'session' ? null : got.emoji
        const outcome = sample.acceptable.includes(emoji) ? 'correct' : sample.acceptable.every(e => e === null) ? 'reacted_when_it_should_not' : emoji === null ? 'missed' : 'wrong_emoji'
        tally[outcome]++
        if (outcome !== 'correct') console.error(JSON.stringify({ run, case: index, outcome, key: got.key, confidence: got.confidence }))
      } catch { tally.errors++ }
    }
  }))
  runs.push(tally)
  console.log(JSON.stringify({ run, cases: data.cases.length, fingerprint, ...tally }))
}
const result = { date: new Date().toISOString().slice(0, 10), model: c.model, fingerprint, cases: data.cases.length, runs }
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
if (runs.some(r => r.errors || r.reacted_when_it_should_not)) process.exitCode = 1
