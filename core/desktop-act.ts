import { cannotUndoLabel } from './browser-act.ts'
import { heldCommand } from './held.ts'

export type DesktopAct =
  | { action: 'click'; x: number; y: number; button: 'left' | 'right'; count: 1 | 2 }
  | { action: 'move'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; path: (readonly [number, number])[] }
  | { action: 'scroll'; x: number; y: number; dy: number; dx: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: string }
export type Under = { app: string; role: string; label: string }
export type Verdict = { run: true } | { ask: string } | { blocked: string }

const MODS = ['ctrl', 'alt', 'shift', 'cmd'] as const
const MOD_NAMES: Record<string, (typeof MODS)[number]> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', cmd: 'cmd', command: 'cmd' }
const KEYS = new Set(['return', 'enter', 'tab', 'space', 'escape', 'esc', 'delete', 'backspace', 'forwarddelete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'power', 'eject',
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''), ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`), ...'-=[]\\;\',./`'.split('')])
const MAX_TEXT = 5000
const MAX_PATH = 200
const MAX_STEPS = 100

function normalKeys(raw: string): string | undefined {
  const parts = raw.toLowerCase().split('+').map(p => p.trim()).filter(Boolean)
  const mods = new Set<string>(), keys: string[] = []
  for (const p of parts) { if (MOD_NAMES[p]) mods.add(MOD_NAMES[p]); else if (KEYS.has(p)) keys.push(p); else return undefined }
  if (keys.length !== 1) return undefined
  return [...MODS.filter(m => mods.has(m)), keys[0]].join('+')
}

const spot = (a: Record<string, unknown>, x: string, y: string) => [a[x], a[y]].every(v => Number.isInteger(v) && (v as number) >= 0) ? [a[x] as number, a[y] as number] as const : undefined

export function parseDesktopAct(a: Record<string, unknown>): DesktopAct | { error: string } {
  const at = spot(a, 'x', 'y')
  switch (a.action) {
    case 'click': {
      if (!at) return { error: 'click needs x and y, whole numbers on the screen picture' }
      const button = a.button ?? 'left', count = a.count ?? 1
      if (button !== 'left' && button !== 'right') return { error: 'button is left or right' }
      if (count !== 1 && count !== 2) return { error: 'count is 1 or 2' }
      return { action: 'click', x: at[0], y: at[1], button, count }
    }
    case 'move': return at ? { action: 'move', x: at[0], y: at[1] } : { error: 'move needs x and y' }
    case 'drag': {
      const to = spot(a, 'to_x', 'to_y')
      if (a.path === undefined) return at && to ? { action: 'drag', x: at[0], y: at[1], path: [to] } : { error: 'drag needs x, y, then to_x and to_y or a path' }
      const path = Array.isArray(a.path) && a.path.length <= MAX_PATH ? a.path.map(p => p && typeof p === 'object' ? spot(p as Record<string, unknown>, 'x', 'y') : undefined) : []
      if (!at || to || !path.length || !path.every(p => p)) return { error: `drag needs x, y and a path of 1 to ${MAX_PATH} points, each whole x and y on the screen picture, and no to_x or to_y` }
      return { action: 'drag', x: at[0], y: at[1], path: path as (readonly [number, number])[] }
    }
    case 'scroll': {
      const dy = Number(a.dy ?? 0), dx = Number(a.dx ?? 0)
      return at && Number.isInteger(dy) && Number.isInteger(dx) && (dy || dx) ? { action: 'scroll', x: at[0], y: at[1], dy, dx } : { error: 'scroll needs x, y and a whole dy or dx' }
    }
    case 'type': return typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_TEXT ? { action: 'type', text: a.text } : { error: `type needs text, 1 to ${MAX_TEXT} characters` }
    case 'key': {
      const keys = typeof a.keys === 'string' ? normalKeys(a.keys) : undefined
      return keys ? { action: 'key', keys } : { error: 'keys is one key with its modifiers, such as cmd+shift+g, return or down' }
    }
    default: return { error: 'action is click, move, drag, scroll, type or key' }
  }
}

export function parseDesktopSteps(steps: unknown): DesktopAct[] | { error: string } {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return { error: `steps is a list of 1 to ${MAX_STEPS} acts` }
  const acts: DesktopAct[] = []
  for (const [i, step] of steps.entries()) {
    const act = step && typeof step === 'object' ? parseDesktopAct(step as Record<string, unknown>) : { error: 'it is not an act' }
    if ('error' in act) return { error: `step ${i + 1}: ${act.error}. No step ran.` }
    acts.push(act)
  }
  return acts
}

const OFF_KEYS = new Set(['ctrl+cmd+q', 'shift+cmd+q', 'alt+shift+cmd+q'])
const SYSTEM_APPS = new Set(['loginwindow', 'system settings', 'system preferences', 'systemuiserver', 'control center'])
const DISK_APPS = new Set(['disk utility', 'system settings', 'system preferences'])
const TERMINALS = new Set(['terminal', 'iterm2', 'iterm', 'ghostty', 'wezterm', 'warp', 'kitty', 'alacritty', 'hyper', 'tabby'])
const POWER = /^\s*(shut ?down|restart|log ?out|sleep|lock screen)\b/i
const ERASE = /\berase\b/i
const WRECK = /\b(shutdown|reboot|halt|poweroff)\b|\bdiskutil\s+(erase\w*|zerodisk|secureerase|partitiondisk|reformat)\b|\bmkfs\b|\bdd\b.*\bof=\/dev\/|\brm\s+(-\S+\s+)*(\/|~|\$HOME)\/?(\s|$)|--no-preserve-root|\bpmset\s+(sleepnow|restartoneshot|shutdown|displaysleepnow)\b|\bosascript\b.*(shut ?down|restart|log ?out|sleep|aevtrlgo|aevtrsdn|aevtrrst|aevtrsht)/i
const PRESSES = new Set(['return', 'enter', 'space'])
const FINDER_DELETES = /^(alt\+)?(shift\+)?cmd\+(delete|backspace)$/
export const sendsLine = (keys: string) => /(^|\+)(return|enter)$/.test(keys) || /^ctrl\+(alt\+)?(shift\+)?(cmd\+)?[mjo]$/.test(keys)
const DESKTOP_UNDOABLE = /\b(move(d)? to (the )?(trash|bin)|uninstall|force quit)\b/i

function targetVerdict(u: Under, how: string): Verdict {
  const app = u.app.toLowerCase(), label = u.label.trim()
  if (POWER.test(label) && (u.role === 'AXMenuItem' || SYSTEM_APPS.has(app))) return { blocked: `${how} "${label}", which turns off, logs out or locks the Mac` }
  if (ERASE.test(label) && DISK_APPS.has(app)) return { blocked: `${how} "${label}" in ${u.app}, which erases a disk or the Mac` }
  if (POWER.test(label) || DESKTOP_UNDOABLE.test(label) || cannotUndoLabel(label)) return { ask: `${how} "${label}" in ${u.app}` }
  return { run: true }
}

export function desktopVerdict(a: DesktopAct, under: Under, typedLine: string | undefined): Verdict {
  if (a.action === 'key') {
    if (OFF_KEYS.has(a.keys) || /\b(power|eject)$/.test(a.keys)) return { blocked: `the keys ${a.keys} turn off, log out or lock the Mac` }
    if (FINDER_DELETES.test(a.keys) && under.app === 'Finder') return { ask: `the keys ${a.keys} move the selected files to the Trash or empty it, in Finder` }
    if (TERMINALS.has(under.app.toLowerCase()) && sendsLine(a.keys)) {
      if (typedLine === undefined) return { ask: `it presses Return in ${under.app} on a line it did not type itself` }
      const line = typedLine.trim()
      if (WRECK.test(line)) return { blocked: `the command \`${line}\` turns off or wipes the Mac` }
      return heldCommand(line) ? { ask: `it runs \`${line}\` in ${under.app}` } : { run: true }
    }
    if (!PRESSES.has(a.keys.split('+').at(-1)!)) return { run: true }
    return targetVerdict(under, a.keys.endsWith('space') ? 'Space presses' : 'Enter confirms')
  }
  if (a.action === 'type' && TERMINALS.has(under.app.toLowerCase()) && /[\r\n]/.test(a.text)) return { blocked: 'in a terminal, type one line at a time, then press return with key, so each command is checked' }
  if (a.action === 'click') return targetVerdict(under, 'it clicks')
  return { run: true }
}
