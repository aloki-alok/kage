// Test helper, not a test: the fake Agent SDK the runner tests (sdk-sessions, chains) drive.
// A fake Agent SDK: each query() records its options and the user messages it reads, and the test
// pushes SDK messages out of it. Its handshake completes unless silent, and then it says nothing
// until it has a prompt, as the real one may. end() makes the Claude
// process exit on its own.
export function fakeSdk(o: { silent?: boolean } = {}) {
  const runs: { options: any; said: string[]; emit: (m: object) => void; end: () => void; closed: boolean; set: object[] }[] = []
  const query = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const out: object[] = []
    let wake = () => {}
    let done = false
    const run = {
      options, said: [] as string[], closed: false, set: [] as object[],
      emit: (m: object) => { out.push(m); wake() },
      end: () => { done = true; wake() },
    }
    runs.push(run)
    void (async () => { for await (const m of prompt) run.said.push(m.message.content) })()
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
