import { findSecret } from './outbound.ts'
import { scrubReport, type IssueReport } from './issue-report.ts'
import { startsSince } from './boots.ts'
import { bridgeProblem, type BridgeSeen } from './whatsapp.ts'
import type { SecretCommand } from './secret-commands.ts'

export type Line = { kind: 'ok' | 'fail' | 'note' | 'fixed'; text: string; fix?: string[][] }
const ok = (text: string): Line => ({ kind: 'ok', text })
const fail = (text: string, fix?: string[][]): Line => ({ kind: 'fail', text, ...fix && { fix } })
const note = (text: string): Line => ({ kind: 'note', text })

export const render = (l: Line) => `${(l.kind === 'fail' ? 'FAIL' : l.kind).padEnd(6)}${l.text}`

export async function applyFixes(lines: Line[], run: (argv: string[]) => Promise<boolean>): Promise<Line[]> {
  const out: Line[] = []
  for (const l of lines) {
    let done = l.kind === 'fail' && !!l.fix
    for (const argv of l.kind === 'fail' ? l.fix ?? [] : []) if (done) done = await run(argv)
    out.push(done ? { kind: 'fixed', text: l.text } : l)
  }
  return out
}

export function stillFixed(fixed: Line[], again: Line[]): Line[] {
  const failing = new Set(again.filter(l => l.kind === 'fail').map(l => l.text))
  return [...again, ...fixed.filter(l => l.kind === 'fixed' && !failing.has(l.text))]
}

export function hubKeyLine(answer: { refused?: unknown } | 'down' | 'silent'): Line | undefined {
  if (answer === 'down' || answer === 'silent') return
  return typeof answer.refused === 'string' ? fail("the hub refused this terminal: owner.key is missing or changed since the hub started. Run kage restart --cut-running")
    : ok("the hub takes this terminal's owner key")
}
export function report(lines: Line[], name: string): { text: string; ok: boolean } {
  const good = !lines.some(l => l.kind === 'fail')
  return { ok: good, text: [...lines.map(render), ...(good ? [`All good. Tag @${name} in Slack to try it.`] : [])].join('\n') }
}

export function nodeOk(version: string): boolean {
  const [a = 0, b = 0] = version.split('.').map(Number)
  return a > 22 || (a === 22 && b >= 18)
}

export const toolsLine = (f: { nodeVersion: string; claude: boolean; tmuxNeeded: boolean; tmux: boolean }): Line =>
  nodeOk(f.nodeVersion) && f.claude && (!f.tmuxNeeded || f.tmux) ? ok('tools: node 22.18+, claude') : fail('tools: run kage check for the missing one')

export function tokenLines(f: { hasSettings: boolean; dir: string; file?: string; mode?: string; link?: boolean; slack: { app?: boolean; user?: boolean; bot?: boolean }; failed?: SecretCommand[] }): Line[] {
  if (!f.hasSettings) return [fail(`tokens: no settings in ${f.dir}. Run kage app, then kage save`)]
  const failed = f.failed ?? []
  const names = [['app', 'SLACK_APP_TOKEN'], ['user', 'SLACK_USER_TOKEN'], ['bot', 'SLACK_BOT_TOKEN']] as const
  return [
    f.mode === '600' ? ok('token file is private (600)') : fail(`token file: run chmod 600 ${f.file}`, f.link ? undefined : [['chmod', '600', f.file!]]),
    ...names.filter(([k]) => !failed.some(c => c.path === `slack.${k}`)).map(([k, n]) => f.slack[k] ? ok(`${n} accepted by Slack`) : fail(`${n}: missing or rejected. Run kage save again`)),
    ...failed.map(c => fail(`secrets.json ${c.path}: its command failed or printed nothing. Run it in a terminal to see why: ${c.command}`)),
  ]
}

export function jevLine(r: { status: number; out: string }): Line | undefined {
  if (r.status === 0) return r.out ? ok(r.out) : undefined
  return fail(r.out || 'jev: the check did not run')
}

export function sandboxLine(f: { on: boolean; platform: string; sandboxExec: boolean; bwrap: boolean; socat: boolean }): Line {
  if (!f.on) return ok('shell sandbox off (harness.sandbox)')
  if (f.platform === 'darwin') return f.sandboxExec ? ok('shell sandbox available') : fail("shell sandbox: /usr/bin/sandbox-exec is missing, so a teammate's thread cannot start. Restore macOS's sandbox-exec, or run: kage set harness.sandbox false")
  return f.bwrap && f.socat ? ok('shell sandbox available') : fail("shell sandbox: a teammate's thread cannot start without bubblewrap and socat. Run: sudo apt install bubblewrap socat, or: kage set harness.sandbox false")
}

export const pluginLine = (onPath: boolean): Line => onPath ? ok('session-manager-plugin found: ssh to SSM hosts works in owner threads')
  : note('ssm: session-manager-plugin is not on the PATH, so ssh to SSM hosts fails in owner threads. Install it (AWS docs: "Install the Session Manager plugin") and restart Kage')

export const keyLines = (keys: Record<string, { host: string; header?: string }> = {}): Line[] =>
  Object.entries(keys).map(([n, k]) => ok(`session key ${n}: kept out of sessions, sent only to ${k.host} (${k.header ?? 'authorization'})`))

export function sessionLines(f: { root?: string; runtime?: string; route?: string; sdkLoads?: boolean; plugin?: boolean; orgApproved?: boolean }): Line[] {
  if (f.runtime !== 'tmux') return [f.sdkLoads ? ok('threads run on the Agent SDK, no prompts') : fail('Agent SDK does not load: run npm ci, then restart (until then threads open as tmux panes)')]
  if (f.route !== 'plugin') return [note('dev route: Claude Code shows a warning screen on each start, and a person confirms it')]
  return [
    f.plugin ? ok('plugin kage@kage installed and enabled') : fail(`plugin: run claude plugin marketplace add "${f.root}" && claude plugin install kage@kage`),
    f.orgApproved ? ok('your Claude org approves the kage channel') : fail("org approval missing: an org Owner adds kage to allowedChannelPlugins (README, 'Run threads as tmux panes instead')"),
  ]
}

export function serviceLines(f: { name: string; installed: boolean; running: boolean; stale: boolean; oldTmux: boolean }): Line[] {
  if (f.installed) return [
    f.running ? ok(`the service keeps ${f.name} running`) : fail(`the service is on but ${f.name} is stopped: kage start`),
    ...(f.stale ? [fail('the service unit still pins KAGE_CWD, so harness.cwd would not apply: kage service on')] : []),
  ]
  return [f.oldTmux ? fail(`${f.name} runs in tmux, which does not bring it back after a reboot or a kill: kage service on`) : fail('not running: kage start')]
}

export const lingerLine = (f: { kind: string; linger: string; user: string }): Line | undefined =>
  f.kind === 'systemd' && f.linger !== 'yes' ? fail(`it starts only once you log in: sudo loginctl enable-linger ${f.user}`) : undefined

export function bootNotes(f: { boots: string | undefined; now: number; darwin: boolean }): Line[] {
  const s = startsSince(f.boots, f.now - 86_400)
  const times = (k: number) => k === 1 ? 'once' : `${k} times`
  return [
    ...(s.crash ? [note(`the hub crashed ${times(s.crash)} in 24 h. The last one: ${s.lastCrash || 'no error line'}. kage logs has the full error`)] : []),
    ...(s.unknown ? [note(`the hub stopped ${times(s.unknown)} in 24 h without saying why (killed, out of memory, or power lost). kage logs shows what ran before it`)] : []),
    ...(f.darwin ? [note('with the lid closed this Mac sleeps, and Kage is offline until it wakes')] : []),
  ]
}

export const slackLines = (f: { connected: boolean; status: string; version: string }): Line[] =>
  f.connected ? [ok(`connected to Slack: ${f.status}`), ok(`runs Kage ${f.version}`)] : [fail('not connected to Slack yet: wait 20 s after start, or run kage logs to see why')]

export function autoUpdateNote(f: { off: boolean; git: boolean; branch?: string; dirty: boolean; origin?: 'failed' | 'no-stable' | 'stable' | 'diverged' }): Line | 'ask-origin' | undefined {
  if (f.off) return note('auto-update is off (autoUpdate is false)')
  if (!f.git) return note('no auto-update: not a git checkout. Rerun the install line to make it one')
  if (f.branch !== 'main') return note(`no auto-update: on branch ${f.branch}, not main`)
  if (f.dirty) return note('no auto-update: the checkout has uncommitted changes')
  if (!f.origin) return 'ask-origin'
  if (f.origin === 'failed') return note('auto-update cannot check origin: git ls-remote failed')
  if (f.origin === 'no-stable') return note('no auto-update: origin has no stable tag yet, so this install stays on its version')
  if (f.origin === 'diverged') return note("auto-update is stuck: the stable tag is not on this checkout's history, and this checkout is not on its. Run kage update to move to origin's main")
  return undefined
}

export const chromeLine = (seenMs: number, nowSec: number, staleMs: number, runs?: string, disk?: string): Line =>
  nowSec * 1000 - seenMs >= staleMs ? fail('Chrome extension not connected: run kage connect browser for the steps to load the extension folder in chrome://extensions')
    : disk && runs !== disk ? fail(`Chrome extension runs ${runs ? `v${runs}` : 'an older version'} but its folder has v${disk}: click reload on Kage in chrome://extensions`)
    : ok(`Chrome extension connected${runs ? ` (v${runs})` : ''}`)

export const pathNote = (onPath: boolean): Line | undefined => onPath ? undefined : note('kage is not on your PATH: run ./setup.sh link to type kage <command> anywhere')

export function ownerChannelLine(channel: 'slack' | 'whatsapp' | undefined, whatsappOn: boolean): Line | undefined {
  if (channel !== 'whatsapp') return undefined
  return whatsappOn
    ? note("Kage's messages and approval cards go to your WhatsApp too: answer a card there with yes or no and its code. Your commands stay in the Slack DM.")
    : fail('owner.channel is whatsapp, but the WhatsApp connector is off, so every message goes to Slack. Turn WhatsApp on (docs/settings.md, "WhatsApp"), or run: kage set owner.channel slack')
}
export function whatsappLine(s: BridgeSeen, at: { url: string; qr: string }): Line {
  const p = bridgeProblem(s, at)
  return p ? fail(p) : ok('WhatsApp bridge up, session WORKING')
}

const shown = (l: string) => { const kind = findSecret(l); return kind ? `${l.split(':')[0]}: its line holds a ${kind}, so run kage doctor in a terminal to see it` : l }

export function doctorNews(out: string, told: string[], last: string[]): { failing: string[]; stable: string[]; dm?: string } {
  const failing = out.trim() ? out.split('\n').filter(l => l.startsWith('FAIL')).map(l => shown(l.slice(4).trim())) : ['the doctor printed nothing, so it did not run']
  const stable = failing.filter(f => last.includes(f))
  if (stable.length === told.length && stable.every(f => told.includes(f))) return { failing, stable }
  if (!stable.length) return { failing, stable, dm: "Kage's hourly check is all good again." }
  return { failing, stable, dm: [`Kage's hourly check found ${stable.length === 1 ? '1 problem' : `${stable.length} problems`}, each on two checks in a row. Each line names its fix, and kage doctor checks again:`, ...stable.map(f => `• ${f}`)].join('\n') }
}

const ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'EPIPE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_MODULE_NOT_FOUND']
const EXPECTED = 'Each doctor check runs and reports ok, FAIL or note, within its time limit.'

export function doctorBug(line: string): IssueReport | undefined {
  const threw = /^(\w+): the check did not run \((.*)\)$/.exec(line)
  const code = threw && ERROR_CODES.find(c => threw[2]!.startsWith(c))
  const r: IssueReport | undefined = threw ? { kind: 'bug', title: `kage doctor: the ${threw[1]} check did not run`, what: `The hub's hourly doctor run: the ${threw[1]} check threw ${code ? `an ${code} error` : 'an error'}. The message stays on the hub, since it can hold paths and names.`, expected: EXPECTED }
    : line.startsWith('the doctor took over') ? { kind: 'bug', title: 'kage doctor: a run took over its time limit', what: `The hub's hourly doctor run: ${line}`, expected: EXPECTED }
    : line.startsWith('the doctor printed nothing') ? { kind: 'bug', title: 'kage doctor: a run printed nothing', what: `The hub's hourly doctor run: ${line}`, expected: EXPECTED }
    : undefined
  return r && scrubReport(r, [])
}

const byModel = (jobs: { model?: string }[]) => {
  const n = new Map<string, number>()
  for (const j of jobs) n.set(j.model ?? 'default', (n.get(j.model ?? 'default') ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m} ${c}`).join(', ')
}

export function runnerLines(f: { opencode: boolean; jobs: { model?: string }[]; kagelets: { model?: string }[] }): Line[] {
  return [
    ok(`runners: claude (every job runs on it). opencode ${f.opencode ? 'is installed, and no job uses it yet' : 'is not installed'}`),
    ...f.jobs.length ? [ok(`scheduled jobs by model: ${byModel(f.jobs)}`)] : [],
    ...f.kagelets.length ? [ok(`kagelets by model: ${byModel(f.kagelets)}`)] : [],
  ]
}
