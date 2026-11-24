import { refusedLine } from './board.ts'

export type Wait = { key: string; why: string }

export async function waitForQuiet(o: {
  ask: () => Promise<Wait[] | { refused: string }>
  say: (line: string) => void
  sleep: (ms: number) => Promise<unknown>
  placeOf: (key: string) => string
  cut: boolean
  command: 'restart' | 'stop'
}): Promise<'quiet' | 'cut' | 'down' | 'refused' | 'silent'> {
  const seen = new Set<string>()
  let missed = 0
  for (;;) {
    let waits: Wait[] | { refused: string }
    try { waits = await o.ask(); missed = 0 } catch (e) {
      if ((e as Error).message === 'down') return 'down'
      if (!o.cut && ++missed < SILENT_ASKS) { await o.sleep(2000); continue }
      return silent(o)
    }
    if (!Array.isArray(waits)) return refused(o, waits.refused)
    if (o.cut) { for (const w of waits) o.say(`Cutting ${o.placeOf(w.key)} (${w.why}).`); return 'cut' }
    if (!waits.length) { o.say('Every thread is quiet.'); return 'quiet' }
    for (const w of waits) if (!seen.has(w.key)) { seen.add(w.key); o.say(`Waiting for ${o.placeOf(w.key)} (${w.why}) to finish its turn.`) }
    await o.sleep(2000)
  }
}

const SILENT_ASKS = 5

function silent(o: { say: (line: string) => void; cut: boolean; command: 'restart' | 'stop' }): 'cut' | 'silent' {
  if (o.cut) { o.say('The hub did not answer. Cutting every running turn, as --cut-running asked.'); return 'cut' }
  o.say(`The hub did not answer. Nothing was cut. To ${o.command} anyway and cut every running turn: kage ${o.command} --cut-running`)
  return 'silent'
}

function refused(o: { say: (line: string) => void; cut: boolean; command: 'restart' | 'stop' }, why: string): 'cut' | 'refused' {
  o.say(refusedLine(why))
  if (o.cut) { o.say('Cutting every running turn, as --cut-running asked.'); return 'cut' }
  o.say(`Nothing was cut. owner.key is likely missing or changed since the hub started. To ${o.command} anyway and cut every running turn: kage ${o.command} --cut-running`)
  return 'refused'
}
