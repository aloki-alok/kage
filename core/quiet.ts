// kage restart and kage stop: drain the hub, then wait until no thread is mid-turn, naming each one it waits on.
// Each ask renews the hub's drain (runtime/limit-pause.ts), so the hub takes new messages again soon after this stops asking.
export type Wait = { key: string; why: string }

export async function waitForQuiet(o: {
  ask: () => Promise<Wait[]>      // rejects with 'down' (no hub) or 'silent' (a hub from before the drain existed)
  say: (line: string) => void
  sleep: (ms: number) => Promise<unknown>
  placeOf: (key: string) => string
  cut: boolean                    // --cut-running: drain once, then cut what runs
}): Promise<'quiet' | 'cut' | 'down'> {
  const seen = new Set<string>()
  let missed = 0
  for (let first = true; ; first = false) {
    let waits: Wait[]
    try { waits = await o.ask(); missed = 0 } catch (e) {
      if ((e as Error).message === 'down') return 'down'
      // Only a first ask with no answer means a hub from before the drain. Later, the hub is just slow: ask again,
      // up to 5 times in a row (about 35 s), so a hung hub cannot keep kage stop waiting for good.
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
