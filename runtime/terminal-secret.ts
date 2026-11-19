import { pickSecret, shownAs, typeKeys, type Keys, type Secret } from '../core/secret-prompt.ts'

const out = process.stderr
const DOTS = 12

const readKeys = (label: string): Promise<string> => new Promise(resolve => {
  let state: Keys = { typed: '' }
  const draw = () => out.write(`\r\u001b[2K${label}${state.typed ? `${'•'.repeat(Math.min(state.typed.length, DOTS))} ${state.typed.length} characters` : ''}`)
  const onKey = (chunk: Buffer) => {
    state = typeKeys(state, chunk.toString('utf8'))
    draw()
    if (!state.end) return
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdin.off('data', onKey)
    if (state.end === 'cancel') { out.write('\n'); process.exit(130) }
    resolve(state.typed)
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', onKey)
  draw()
})

const readPiped = async () => { let s = ''; for await (const c of process.stdin) s += c; return s }

export async function askSecret(label: string, want: Secret, optional = false): Promise<string> {
  if (!process.stdin.isTTY) return pickSecret(await readPiped(), want).value
  for (;;) {
    const { value, problem } = pickSecret(await readKeys(label), want)
    if (value) { out.write(`\r\u001b[2K${label}✓ ${shownAs(value)}\n`); return value }
    out.write('\n')
    if (!problem && optional) return ''
    out.write(`${problem ?? 'Nothing was pasted.'} Try again, or press Ctrl-C to stop.\n`)
  }
}
