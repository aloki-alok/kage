export type Wait = { key: string; why: string }

export async function waitForQuiet(o: {
  ask: () => Promise<Wait[]>
  say: (line: string) => void
  sleep: (ms: number) => Promise<unknown>
  placeOf: (key: string) => string
  cut: boolean
}): Promise<'quiet' | 'cut' | 'down'> {
  const seen = new Set<string>()
  let missed = 0
  for (let first = true; ; first = false) {
    let waits: Wait[]
    try { waits = await o.ask(); missed = 0 } catch (e) {
      if ((e as Error).message === 'down') return 'down'
      if (!first && ++missed < 5) { await o.sleep(2000); continue }
      if (!first) { o.say('The hub does not answer, so its turns are cut.'); return 'cut' }
      o.say('This hub is older and cannot wait for running turns, so they are cut.')
      return 'cut'
    }
    if (o.cut) { for (const w of waits) o.say(`Cutting ${o.placeOf(w.key)} (${w.why}).`); return 'cut' }
    if (!waits.length) { o.say('Every thread is quiet.'); return 'quiet' }
    for (const w of waits) if (!seen.has(w.key)) { seen.add(w.key); o.say(`Waiting for ${o.placeOf(w.key)} (${w.why}) to finish its turn.`) }
    await o.sleep(2000)
  }
}
