import { painter } from '../core/voice.ts'
import { pickSecret, shownAs, typeKeys, type Keys, type Secret } from '../core/secret-prompt.ts'

const out = process.stderr
const v = painter(Boolean(out.isTTY) && !process.env.NO_COLOR)
const fit = (line: string) => line.slice(0, Math.max(20, (out.columns || 80) - 1))
const DOTS = 12

const readKeys = (label: string): Promise<string> => new Promise(resolve => {
  let state: Keys = { typed: '' }
  const draw = () => out.write(`\r\u001b[2K${fit(`${label}${state.typed ? `${'•'.repeat(Math.min(state.typed.length, DOTS))} ${state.typed.length} characters` : ''}`)}`)
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
  if (!process.stdin.isTTY) return optional ? '' : pickSecret(await readPiped(), want).value
  for (;;) {
    const { value, problem } = pickSecret(await readKeys(label), want)
    if (value) {
      const plain = `${label}✓ ${shownAs(value)}`
      out.write(`\r\u001b[2K${fit(plain) === plain ? `${label}${v.ok(v.dim(shownAs(value)))}` : fit(plain)}\n`)
      return value
    }
    out.write('\n')
    if (!problem && optional) return ''
    out.write(`${v.says(problem ?? 'Nothing was pasted.')} ${v.dim('Try again, or Ctrl-C to stop.')}\n`)
  }
}
