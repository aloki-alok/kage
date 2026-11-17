// What `kage doctor` decides from the facts cli/doctor/ gathers. Pure: no file, process or network here (ADR 0001).
// The output format is read by people and by the release soak gate (runtime/release.ts looks for "All good"): keep it.
import { bridgeProblem, type BridgeSeen } from './whatsapp.ts'

export type Line = { kind: 'ok' | 'fail' | 'note'; text: string }
const ok = (text: string): Line => ({ kind: 'ok', text })
const fail = (text: string): Line => ({ kind: 'fail', text })
const note = (text: string): Line => ({ kind: 'note', text })

export const render = (l: Line) => `${(l.kind === 'fail' ? 'FAIL' : l.kind).padEnd(6)}${l.text}`

// The whole output. The closing line appears only when nothing failed.
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

// mode is the token file's permission bits in octal text, such as "600".
export function tokenLines(f: { hasSettings: boolean; dir: string; file?: string; mode?: string; slack: { app?: boolean; user?: boolean; bot?: boolean } }): Line[] {
  if (!f.hasSettings) return [fail(`tokens: no settings in ${f.dir}. Run kage app, then kage save`)]
  const names = [['app', 'SLACK_APP_TOKEN'], ['user', 'SLACK_USER_TOKEN'], ['bot', 'SLACK_BOT_TOKEN']] as const
  return [
    f.mode === '600' ? ok('token file is private (600)') : fail(`token file: run chmod 600 ${f.file}`),
    ...names.map(([k, n]) => f.slack[k] ? ok(`${n} accepted by Slack`) : fail(`${n}: missing or rejected. Run kage save again`)),
  ]
}

// cli/jev-doctor.ts: exit 0 with no output is "Jev is off".
export function jevLine(r: { status: number; out: string }): Line | undefined {
  if (r.status === 0) return r.out ? ok(r.out) : undefined
  return fail(r.out || 'jev: the check did not run')
}

export function sandboxLine(f: { on: boolean; platform: string; sandboxExec: boolean; bwrap: boolean; socat: boolean }): Line {
  if (!f.on) return ok('shell sandbox off (harness.sandbox)')
  if (f.platform === 'darwin') return f.sandboxExec ? ok('shell sandbox available') : fail("shell sandbox: /usr/bin/sandbox-exec is missing, so sessions cannot start. Restore macOS's sandbox-exec")
  return f.bwrap && f.socat ? ok('shell sandbox available') : fail('shell sandbox: sessions cannot start without bubblewrap and socat. Run: sudo apt install bubblewrap socat')
}

// ssh to an SSM host from an owner thread runs the real session-manager-plugin in the hub (runtime/ssm-relay.ts), so the hub's PATH needs it.
export const pluginLine = (onPath: boolean): Line => onPath ? ok('session-manager-plugin found: ssh to SSM hosts works in owner threads')
  : note('ssm: session-manager-plugin is not on the PATH, so ssh to SSM hosts fails in owner threads. Install it (AWS docs: "Install the Session Manager plugin") and restart Kage')

// Each proxied key by name (#182), never its value: where it may go and in which header.
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

// boots is the hub's file of start times in seconds, one per line; undefined on a fresh install, which has no starts yet (#90).
export function bootNotes(f: { boots: string | undefined; now: number; darwin: boolean }): Line[] {
  const n = (f.boots ?? '').split('\n').filter(l => Number(l.split(/\s/)[0]) > f.now - 86_400).length
  return [
    ...(n > 5 ? [note(`the hub started ${n} times in 24 h: kage logs shows why`)] : []),
    ...(f.darwin ? [note('with the lid closed this Mac sleeps, and Kage is offline until it wakes')] : []),
  ]
}

export const slackLines = (f: { connected: boolean; status: string; version: string }): Line[] =>
  f.connected ? [ok(`connected to Slack: ${f.status}`), ok(`runs Kage ${f.version}`)] : [fail('not connected to Slack yet: wait 20 s after start, or run kage logs to see why')]

// The same rules as core/auto-update.ts, so a person sees why this install stays on its version.
// 'ask-origin' means the caller must ls-remote the stable tag and ask again with origin set.
export function autoUpdateNote(f: { off: boolean; git: boolean; branch?: string; dirty: boolean; origin?: 'failed' | 'no-stable' | 'stable' | 'diverged' }): Line | 'ask-origin' | undefined {
  if (f.off) return note('auto-update is off (autoUpdate is false)')
  if (!f.git) return note('no auto-update: not a git checkout. Rerun the install line to make it one')
  if (f.branch !== 'main') return note(`no auto-update: on branch ${f.branch}, not main`)
  if (f.dirty) return note('no auto-update: the checkout has uncommitted changes')
  if (!f.origin) return 'ask-origin'
  if (f.origin === 'failed') return note('auto-update cannot check origin: git ls-remote failed')
  if (f.origin === 'no-stable') return note('no auto-update: origin has no stable tag yet, so this install stays on its version')
  // A moved or rewritten tag: neither commit holds the other, so a fast-forward never comes and the install would wait forever.
  if (f.origin === 'diverged') return note("auto-update is stuck: the stable tag is not on this checkout's history, and this checkout is not on its. Run kage update to move to origin's main")
  return undefined
}

// The hub notes each poll of the Chrome extension in browser-seen (ms).
// The extension reloads itself when the folder's version changes (extension/background.js); a gap means it could not.
export const chromeLine = (seenMs: number, nowSec: number, runs?: string, disk?: string): Line =>
  nowSec - seenMs / 1000 >= 120 ? fail('Chrome extension not connected: run kage add browser for the steps to load the extension folder in chrome://extensions')
    : disk && runs !== disk ? fail(`Chrome extension runs ${runs ? `v${runs}` : 'an older version'} but its folder has v${disk}: click reload on Kage in chrome://extensions`)
    : ok(`Chrome extension connected${runs ? ` (v${runs})` : ''}`)

export const pathNote = (onPath: boolean): Line | undefined => onPath ? undefined : note('kage is not on your PATH: run ./setup.sh link to type kage <command> anywhere')

// Checked only when WhatsApp is on (connectors/whatsapp.ts wahaSeen looks).
export function whatsappLine(s: BridgeSeen, at: { url: string; qr: string }): Line {
  const p = bridgeProblem(s, at)
  return p ? fail(p) : ok('WhatsApp bridge up, session WORKING')
}
