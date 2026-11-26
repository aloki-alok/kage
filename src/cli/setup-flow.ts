import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { validName } from '../core/gate.ts'
import { fillSlackTokens, slackSlots, typeLines, type SlackSlots } from '../core/secret-prompt.ts'
import { slackTransport } from '../core/slack-transport.ts'
import { FLICKER, MARK, besideWordmark, painter } from '../core/voice.ts'
import { envFilePath, readSettings } from '../runtime/config-files.ts'

const ROOT = join(import.meta.dirname, '../..')
const keys = Boolean(process.stdin.isTTY), screen = Boolean(process.stdout.isTTY)
const v = painter(screen && !process.env.NO_COLOR)
const out = (s = '') => process.stdout.write(`${s}\n`)
const rail = v.faint('│')
const gap = () => out(`  ${rail}`)
const done = (label: string, detail = '') => out(`  ${v.work(MARK.kage)}  ${label.padEnd(12)} ${v.dim(detail)}`.trimEnd())
const needs = (s: string) => out(`  ${v.you(MARK.you)}  ${s}`)
const erase = (lines: number) => { if (screen && lines) process.stdout.write(`\x1b[${lines}A\r\x1b[J`) }
const link = (url: string, text: string) => screen ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text
const sh = (args: string[], input?: string) => {
  const r = spawnSync('./setup.sh', args, { cwd: ROOT, input, encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
const stop = (why: string) => { needs(v.you(why)); process.exit(1) }

const piped = keys ? [] : readFileSync(0, 'utf8').split('\n')
async function ask(prompt: string): Promise<string> {
  if (!keys) { process.stdout.write(`${prompt}\n`); return (piped.shift() ?? '').trim() }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(prompt)).trim() } finally { rl.close() }
}

function header() {
  const right = ['', `${v.work(MARK.kage)} Hi, I'm Kage. Let's get me into Slack.`, v.dim('  3 minutes · Ctrl-C quits')]
  out()
  for (const line of screen && (process.stdout.columns ?? 0) >= 80 ? besideWordmark(v, right) : right.slice(1)) out(line)
  out()
}

function tools() {
  const r = sh(['check'])
  if (!r.ok) stop(r.out.replace(/^.*?◆\s*/s, ''))
  done('Tools ready', r.out.replace(/^ok:\s*/, '').replace(/, /g, ' · '))
}

async function name(): Promise<string> {
  for (let tries = 0; ; tries++) {
    const typed = (await ask(`  ${v.you(MARK.you)}  What do you call me in Slack? ${v.dim('[kage]')} `)).toLowerCase() || 'kage'
    erase(1 + Math.min(tries, 1))
    if (validName(typed)) { done('Name', `@${typed}`); return typed }
    needs(`${typed} won't work. Use lowercase letters, digits, dashes.`)
  }
}

async function slackApp(nameIs: string) {
  const r = sh(['app', nameIs])
  const url = r.out.split('\n').find(l => l.startsWith('https://')) ?? ''
  if (!r.ok || !url) stop(r.out || 'Could not make the Slack app link.')
  const lines = [
    `  ${v.you(MARK.you)}  ${'Slack app'.padEnd(12)} ${link(url, v.work('opened in your browser ↗'))}`,
    `  ${rail}  ${v.dim('1')}  Pick the workspace, then ${v.work('Next')} and ${v.work('Create')}`,
    `  ${rail}  ${v.dim('2')}  Basic Information › App-Level Tokens › ${v.work('Generate')}, scope ${v.work('connections:write')}`,
    `  ${rail}  ${v.dim('3')}  Install App › Install to Workspace › ${v.work('Allow')}`,
    `  ${rail}  ${v.dim('Needs approval? A workspace admin gives it once.')}`,
  ]
  for (const l of lines) out(l)
  for (;;) {
    const a = await ask(`  ${rail}  ${v.you('Enter when you see the tokens')} ${v.dim('(o reopens)')} `)
    if (a.toLowerCase() !== 'o') break
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
    erase(1)
  }
  erase(lines.length + 1)
  done('Slack app', 'created')
}

const transport = (() => { try { return slackTransport(readSettings(envFilePath())) } catch { return 'socket' as const } })()
const SLOTS = slackSlots(transport).map(([k, s]) => [k, s.shape ? 'signing' : s.prefix.slice(0, -1)] as const)
const slotLine = (s: SlackSlots) => SLOTS.map(([k, p]) => s[k] ? `${v.work('✓')} ${p}` : v.dim(`${MARK.quiet} ${p}`)).join('    ')
const full = (s: SlackSlots) => SLOTS.every(([k]) => s[k])

function hiddenLines(draw: (typed: string) => void, take: (line: string) => boolean): Promise<void> {
  return new Promise(resolve => {
    let typed = ''
    const end = () => { process.stdin.off('data', onKey); process.stdin.setRawMode(false); process.stdin.pause(); resolve() }
    const onKey = (chunk: Buffer) => {
      const r = typeLines(typed, chunk.toString('utf8'))
      if (r.cancel) { process.stdin.setRawMode(false); out(); process.exit(130) }
      typed = r.typed
      for (const line of r.lines) if (line.trim() && take(line)) return end()
      draw(typed)
    }
    process.stdin.on('data', onKey); process.stdin.resume(); draw(typed)
  })
}

async function tokens(start: SlackSlots): Promise<SlackSlots> {
  let slots = start, problem = ''
  if (keys) process.stdin.setRawMode(true)
  needs(`Paste the three ${transport === 'http' ? 'Slack values' : 'tokens'} ${v.dim('(any order)')}`)
  if (!keys) {
    while (!full(slots) && piped.length) slots = fillSlackTokens(slots, piped.shift()!, transport).slots
    if (!full(slots)) stop(transport === 'http' ? 'Need the signing secret, xoxp-... and xoxb-...' : 'Need all three tokens: xapp-..., xoxp-..., xoxb-...')
    return slots
  }
  const block = (typed: string) => [
    `  ${rail}  ${slotLine(slots)}`,
    `  ${rail}  ${v.you('›')} ${v.dim('•'.repeat(Math.min(typed.length, 24)))}${typed ? v.dim(` ${typed.length}`) : ''}`,
    `  ${rail}  ${problem ? v.you(problem) : v.dim('They stay on this computer.')}`,
  ]
  let drawn = 0
  const draw = (typed: string) => { erase(drawn); const b = block(typed); for (const l of b) out(l); drawn = b.length }
  await hiddenLines(draw, line => {
    const r = fillSlackTokens(slots, line, transport)
    slots = r.slots; problem = r.problem ?? ''
    return full(slots)
  })
  erase(drawn + 1)
  return slots
}

async function save(nameIs: string): Promise<void> {
  let slots: SlackSlots = {}
  for (;;) {
    slots = await tokens(slots)
    const r = sh(['save', nameIs], `${SLOTS.map(([k]) => slots[k]).join(' ')}\n`)
    if (r.ok) { done('Tokens', 'ok'); return }
    const bad = r.out.match(/\((xapp|xoxp|xoxb)-\) rejected/)?.[1]
    if (!keys || !bad) stop(r.out.split('\n').filter(Boolean).pop() ?? 'Slack refused the tokens.')
    needs(v.you(`Slack refused the ${bad}- token. Copy it again.`))
    const key = SLOTS.find(([, p]) => p === bad)![0]
    slots = { ...slots, [key]: undefined }
  }
}

function connected(dir: string): boolean {
  try {
    const [state, , , pid] = readFileSync(join(dir, 'status'), 'utf8').trim().split(/\s+/)
    if (state !== 'connected' || !pid) return false
    process.kill(Number(pid), 0)
    return true
  } catch { return false }
}

async function start(nameIs: string) {
  const r = sh(['start'])
  if (!r.ok) stop(r.out.split('\n').filter(Boolean).pop() ?? 'Could not start.')
  const dir = dirname(envFilePath()), wait = Number(process.env.KAGE_SETUP_WAIT ?? 90), began = Date.now()
  let frame = 0
  while (!connected(dir) && Date.now() - began < wait * 1000) {
    if (screen) process.stdout.write(`\r\x1b[2K  ${v.work(FLICKER[frame++ % FLICKER.length]!)}  ${'Starting'.padEnd(12)} ${v.dim(`waiting for Slack · ${Math.round((Date.now() - began) / 1000)} s`)}`)
    await new Promise(res => setTimeout(res, 250))
  }
  if (screen) process.stdout.write('\r\x1b[2K')
  if (!connected(dir)) stop(`Not connected to Slack after ${wait} s. Run kage doctor: it names the fix for each problem.`)
  done(`Connected to Slack. Tag @${nameIs} in any thread to try it.`)
  gap()
  out(`  ${v.faint('╰')}  ${v.dim('🥷 when I start, ⚔️ when I finish.')}`)
  out()
  out(`     ${v.command('kage top'.padEnd(13))}${v.dim('watch me work')}`)
  out(`     ${v.command('kage doctor'.padEnd(13))}${v.dim('check on me')}`)
  if (spawnSync('sh', ['-c', 'command -v kage'], { encoding: 'utf8' }).status !== 0) out(`     ${v.dim('Open a new terminal to use kage.')}`)
  out()
}

header()
out(`  ${v.faint('╭')}  ${v.dim('kage setup')}`)
if (connected(dirname(envFilePath()))) {
  done('Kage is set up and connected to Slack.')
  out(`     ${v.command('kage slack save'.padEnd(13))}${v.dim('change the Slack tokens')}`)
  out(`     ${v.command('kage doctor'.padEnd(13))}${v.dim('check on me')}`)
  out(`     ${v.dim('To set it up again from scratch, run kage stop first.')}`)
  out()
  process.exit(0)
}
gap()
tools(); gap()
const nameIs = await name(); gap()
await slackApp(nameIs); gap()
await save(nameIs); gap()
await start(nameIs)
