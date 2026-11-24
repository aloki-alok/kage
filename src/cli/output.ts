import { spawnSync } from 'node:child_process'

export type Output = { json: boolean; jq?: string; args: string[] }

export function outputFlags(argv: string[]): Output {
  const args: string[] = []
  let json = false, jq: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true
    else if (argv[i] === '--jq') {
      jq = argv[++i]
      if (jq === undefined) { console.error('--jq takes a filter, such as --jq ".[].id"'); process.exit(2) }
      json = true
    } else args.push(argv[i]!)
  }
  return { json, ...jq !== undefined && { jq }, args }
}

const JQ_BAD_FILTER = 3

export function printJson(value: unknown, jq?: string) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (jq === undefined) { process.stdout.write(text); return }
  const r = spawnSync('jq', [jq], { input: text, stdio: ['pipe', 'inherit', 'inherit'] })
  if (r.error) { console.error('--jq needs jq on your PATH (macOS: brew install jq). --json alone prints the same rows.'); process.exit(1) }
  if (r.status) process.exit(r.status === JQ_BAD_FILTER ? 2 : 1)
}
