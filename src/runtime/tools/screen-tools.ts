import { z } from 'zod'
import { desktopVerdict, onScreen, parseDesktopAct, parseDesktopSteps, sendsLine, type DesktopAct, type Picture, type Under } from '../../core/desktop-act.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'
import type { ActAnswer } from '../screen.ts'

type Screen = NonNullable<ToolContext['o']['screen']>
type Desk = {
  c: ToolContext; screen: Screen
  where: { channel: z.ZodString; thread_ts: z.ZodString }; app: z.ZodOptional<z.ZodString>
  typed: Map<string, string | undefined>; picture?: Picture
}

const MAX_SECONDS = 600
const NO_PICTURE = 'take a screenshot first: coordinate is pixels on its picture'
const ACTIONS = ['screenshot', 'left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag', 'scroll', 'type', 'key'] as const
const AIMED = new Set(['left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag', 'scroll'])

const command = ({ action, ...rest }: DesktopAct) => ({ op: action, ...rest })
const asUnder = (r: ActAnswer): Under => ({ app: String(r.app ?? ''), role: String(r.role ?? ''), label: String(r.label ?? '') })
const expectOf = (act: DesktopAct, u: Under) =>
  act.action === 'click' || (act.action === 'key' && /(^|\+)(return|enter|space)$/.test(act.keys)) ? { expect: u }
    : act.action === 'key' || act.action === 'type' ? { expect: { app: u.app } } : {}
const ran = (n: number) => n === 0 ? 'No step ran.' : n === 1 ? 'Only step 1 ran.' : `Steps 1 to ${n} ran.`
const fail = (text: string) => ({ isError: true as const, text })
const refused = (c: ToolContext, args: Record<string, unknown>) => c.ownerActs(args) ? undefined : { isError: true as const, text: "refused: only the owner's own task sees their screen" }
const seen = (c: ToolContext, tool: string, outcome: string) => c.o.event?.('tool', `${tool} ${outcome}`)
const fileFor = (c: ToolContext, args: Record<string, unknown>, ext: string) => `${c.filesOf(String(args.channel), String(args.thread_ts))}/screen-${Date.now()}.${ext}`
const pair = (v: unknown) => Array.isArray(v) ? { x: v[0], y: v[1] } : {}

function fromComputer(a: Record<string, unknown>): Record<string, unknown> | { error: string } {
  if (!ACTIONS.includes(a.action as typeof ACTIONS[number]) || a.action === 'screenshot') return { error: `action is one of ${ACTIONS.filter(x => x !== 'screenshot').join(', ')}` }
  if (AIMED.has(a.action as string) && !Array.isArray(a.coordinate) && !(a.action === 'left_click_drag' && a.path !== undefined)) return { error: `${a.action} needs coordinate, [x, y] on the screenshot` }
  const at = pair(a.coordinate)
  switch (a.action) {
    case 'left_click': return { action: 'click', ...at, button: 'left', count: 1 }
    case 'right_click': return { action: 'click', ...at, button: 'right', count: 1 }
    case 'double_click': return { action: 'click', ...at, button: 'left', count: 2 }
    case 'mouse_move': return { action: 'move', ...at }
    case 'left_click_drag': {
      const from = pair(a.start_coordinate)
      if (a.path === undefined) return { action: 'drag', ...from, to_x: at.x, to_y: at.y }
      return { action: 'drag', ...from, path: Array.isArray(a.path) ? a.path.map(pair) : a.path }
    }
    case 'scroll': {
      const n = Number(a.scroll_amount ?? 3), d = a.scroll_direction
      return { action: 'scroll', ...at, dy: d === 'up' ? n : d === 'down' ? -n : 0, dx: d === 'left' ? n : d === 'right' ? -n : 0 }
    }
    case 'type': return { action: 'type', text: a.text }
    default: return { action: 'key', keys: a.text }
  }
}

export function screenTools(c: ToolContext): KageTool[] {
  const { o, s, name } = c
  const screen = o.screen
  if (!screen || name || o.dreaming) return []
  const desk: Desk = {
    c, screen, typed: new Map(),
    where: { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') },
    app: s.optional().describe('screenshot: only this app\'s windows, by name ("Google Chrome") or bundle id; leave it out for the whole main display'),
  }
  return [computerTool(desk), recordTool(desk)]
}

async function lookUnder({ screen }: Desk, act: DesktopAct, focus?: Under): Promise<Under | { error: string }> {
  const looked = act.action === 'click' ? await screen.act({ op: 'under', x: act.x, y: act.y }) : focus ? {} : act.action === 'key' || act.action === 'type' ? await screen.act({ op: 'focused' }) : {}
  return 'error' in looked ? { error: String(looked.error) } : act.action === 'click' || !focus ? asUnder(looked) : focus
}

function verdictOf({ c, typed }: Desk, act: DesktopAct, under: Under) {
  const v = desktopVerdict(act, under, typed.get(under.app))
  if ('blocked' in v) seen(c, 'computer', `${act.action} refused`)
  return 'blocked' in v ? { blocked: `refused: ${v.blocked}. This is never done on the owner's Mac.` } : v
}

async function perform({ c, screen, typed }: Desk, act: DesktopAct, under: Under): Promise<string | undefined> {
  const line = typed.get(under.app)
  if (act.action !== 'type' && act.action !== 'key') typed.clear()
  else typed.set(under.app, act.action === 'type' ? line === undefined ? undefined : line + act.text : sendsLine(act.keys) || act.keys === 'ctrl+c' ? '' : undefined)
  const r = await screen.act({ ...command(act), ...expectOf(act, under) })
  seen(c, 'computer', 'error' in r ? `${act.action} failed` : `${act.action} ok`)
  return 'error' in r ? String(r.error) : undefined
}

async function runSteps(desk: Desk, acts: DesktopAct[]): Promise<Result> {
  let front: string | undefined
  for (const [i, act] of acts.entries()) {
    const at = `step ${i + 1} of ${acts.length}`
    const looked = await desk.screen.act({ op: 'focused' })
    if ('error' in looked) return fail(`${at}: ${String(looked.error)}. ${ran(i)}`)
    const focus = asUnder(looked)
    front ??= focus.app
    if (focus.app !== front) return fail(`${at} did not run: the front app changed from ${front} to ${focus.app}, so the owner may be using the Mac. ${ran(i)} Take a screenshot before you go on.`)
    const under = await lookUnder(desk, act, focus)
    if ('error' in under) return fail(`${at}: ${under.error}. ${ran(i)}`)
    const v = verdictOf(desk, act, under)
    if ('blocked' in v) return fail(`${at}: ${v.blocked} ${ran(i)}`)
    if ('ask' in v) return fail(`${at} needs the owner's yes (${v.ask}), so it did not run. ${ran(i)} Send that step alone as its own computer call, so the owner gets a card for it.`)
    const err = await perform(desk, act, under)
    if (err) return fail(`${at} failed: ${err}. ${ran(i)}`)
  }
  return { text: `done, ${acts.length} steps. Take a screenshot to see the result.` }
}

function stepShape(s: z.ZodString) {
  const point = z.tuple([z.number(), z.number()])
  return {
    action: z.enum(ACTIONS),
    coordinate: point.optional().describe('[x, y] pixels on the latest screenshot: where to click, move, scroll, or where a drag ends'),
    start_coordinate: point.optional().describe('left_click_drag: where the drag starts'),
    path: z.array(point).optional().describe('left_click_drag: instead of coordinate, the points it passes through in order, up to 200, for a curve in one stroke'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(), scroll_amount: z.number().optional().describe('scroll: lines, 3 unless set'),
    text: s.optional().describe('type: the text. key: one key and its modifiers, such as cmd+shift+g or return'),
  }
}

function computerTool(desk: Desk): KageTool {
  const step = stepShape(desk.c.s)
  return {
    name: 'computer',
    description: "Use the owner's Mac as a person would. screenshot takes a picture of the screen (or of one app's windows) as a PNG in this thread's files folder: read it to see the screen, or send it with send_file. Then left_click, right_click, double_click, mouse_move, left_click_drag (along a path for a curve), scroll, type text, or key (cmd+shift+g, return, down). coordinate is [x, y] pixels on the latest screenshot (its answer names the size), so take one first, and again after each step that changes the screen in a way you cannot predict. For several steps you can plan from one picture (strokes of a drawing, a form), send them as steps, one list in one call: each step is still checked, and the list stops at the first step that fails, is refused, needs the owner's yes, or finds a different app in front (the owner may have taken over). Keep a list in one app. The owner sees Kage's own cursor make each step. Everyday steps run at once. A step that cannot be undone (Delete, Move to Trash, a one-way command in a terminal) waits for the owner's yes, and turning the Mac off, logging out, locking it or erasing it is refused. In a terminal, press ctrl+c first for a clean line, type one line, then press return. Any other key or a click there makes the line unknown, so its Return waits for the owner. Owner tasks only.",
    shape: { ...desk.where, ...step, app: desk.app, action: step.action.optional().describe('one step; leave it out when you send steps'), steps: z.array(z.object(step)).optional().describe('a list of 1 to 100 steps (not screenshot), each shaped like one step, run in order in this one call') },
    async run(args) {
      const no = refused(desk.c, args); if (no) return no
      if (args.steps !== undefined) return actSteps(desk, args)
      return args.action === 'screenshot' ? screenshot(desk, args) : actOnce(desk, args)
    },
  }
}

function actSteps(desk: Desk, args: Record<string, unknown>) {
  if (args.action !== undefined) return fail('give action for one step, or steps for a list, not both')
  const raw = Array.isArray(args.steps) ? args.steps.map(st => st && typeof st === 'object' ? fromComputer(st as Record<string, unknown>) : st) : args.steps
  const bad = Array.isArray(raw) ? raw.findIndex(r => r && typeof r === 'object' && 'error' in r) : -1
  if (bad >= 0) return fail(`step ${bad + 1}: ${(raw as { error: string }[])[bad]!.error}. No step ran.`)
  const acts = parseDesktopSteps(raw)
  if ('error' in acts) return fail(acts.error)
  const picture = desk.picture
  if (!picture && acts.some(a => 'x' in a)) return fail(NO_PICTURE)
  return runSteps(desk, acts.map(a => picture ? onScreen(a, picture) : a))
}

async function actOnce(desk: Desk, args: Record<string, unknown>): Promise<Result> {
  const { c, picture } = desk
  const raw = fromComputer(args)
  if ('error' in raw) return fail(String(raw.error))
  const parsed = parseDesktopAct(raw)
  if ('error' in parsed) return fail(parsed.error)
  if (!picture && 'x' in parsed) return fail(NO_PICTURE)
  const act = picture ? onScreen(parsed, picture) : parsed
  const under = await lookUnder(desk, act)
  if ('error' in under) return fail(under.error)
  const v = verdictOf(desk, act, under)
  if ('blocked' in v) return fail(v.blocked)
  if ('ask' in v) {
    if (!c.o.approve) return fail(`refused: ${v.ask}, which needs the owner's yes, and this session cannot ask them`)
    if (!await c.o.approve('computer', `${v.ask}, on your Mac`, { ...act })) { seen(c, 'computer', `${act.action} owner said no`); return fail('the owner said no, so nothing was done. Ask them what to do instead.') }
  }
  const err = await perform(desk, act, under)
  return err ? fail(err) : { text: 'done. Take a screenshot to see the result.' }
}

async function screenshot(desk: Desk, args: Record<string, unknown>): Promise<Result> {
  const { c, screen } = desk
  const file = fileFor(c, args, 'png')
  const r = await screen.shot(file, args.app as string | undefined)
  seen(c, 'computer', typeof r === 'string' ? 'screenshot failed' : 'screenshot ok')
  if (typeof r === 'string') return { isError: true, text: r }
  desk.picture = r
  return { text: `saved ${file}, ${r.width} by ${r.height} pixels. coordinate is [x, y] pixels on this picture.` }
}

function recordTool({ c, screen, where, app }: Desk): KageTool {
  return {
    name: 'screen_record',
    description: `Record the owner's Mac screen as an MP4, or only one app's windows. start begins it and returns at once, so you can work while it records (for example with browser_click); stop ends it and gives the file for send_file. It stops by itself after seconds (300 unless set, at most ${MAX_SECONDS}). One recording at a time. Owner tasks only.`,
    shape: { ...where, action: z.enum(['start', 'stop']), app, seconds: z.number().optional().describe(`start: the longest it may run, at most ${MAX_SECONDS}`) },
    async run(args) {
      const no = refused(c, args); if (no) return no
      if (args.action === 'stop') {
        const r = await screen.stop()
        seen(c, 'screen_record', 'error' in r ? 'stop failed' : 'stop ok')
        return 'error' in r ? { isError: true, text: r.error } : { text: `saved ${r.file} (${r.seconds} s). Send it with send_file.` }
      }
      const seconds = Math.max(1, Math.min(MAX_SECONDS, Math.round(Number(args.seconds) || 300)))
      const err = await screen.start(fileFor(c, args, 'mp4'), seconds, args.app as string | undefined)
      seen(c, 'screen_record', err ? 'start failed' : 'start ok')
      return err ? { isError: true, text: err } : { text: `recording, for at most ${seconds} s. Do the steps, then call screen_record with action stop.` }
    },
  }
}
