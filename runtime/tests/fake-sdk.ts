export function fakeSdk(o: { silent?: boolean } = {}) {
  const runs: { options: any; said: string[]; uuids: (string | undefined)[]; emit: (m: object) => void; end: () => void; closed: boolean; set: object[] }[] = []
  const query = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const out: object[] = []
    let wake = () => {}
    let done = false
    const run = {
      options, said: [] as string[], uuids: [] as (string | undefined)[], closed: false, set: [] as object[],
      emit: (m: object) => { out.push(m); wake() },
      end: () => { done = true; wake() },
    }
    runs.push(run)
    void (async () => { for await (const m of prompt) { run.said.push(m.message.content); run.uuids.push(m.uuid) } })()
    return {
      initializationResult: () => o.silent ? new Promise(() => {}) : Promise.resolve({}),
      close() { run.closed = true; run.end() },
      async setModel(model?: string) { run.set.push({ model }) },
      async applyFlagSettings(x: object) { run.set.push(x) },
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (out.length) yield out.shift()
          if (done) return
          await new Promise<void>(r => { wake = r })
        }
      },
    }
  }
  return { runs, query }
}
