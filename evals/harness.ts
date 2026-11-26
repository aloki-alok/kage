import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Dispatcher, type Delivery } from '../src/core/sessions.ts'
import { taskAsOther, taskAsOwner } from '../src/core/gate.ts'
import type { Task } from '../src/core/task.ts'
import { sessionTools } from '../src/runtime/kage-tools.ts'
import { sdkSessions } from '../src/runtime/sdk-sessions.ts'
import { openStore } from '../src/runtime/store.ts'
import { openLedgers, runEvents } from '../src/runtime/ledger.ts'
import { scheduler } from '../src/runtime/scheduler.ts'
import { kageletManager } from '../src/runtime/kagelets/manager.ts'
import { kageletRoutes } from '../src/runtime/kagelets/routes.ts'
import { kageletIncidents } from '../src/runtime/kagelets/incidents.ts'
import { readKagelets } from '../src/runtime/kagelets/files.ts'
import { syncKagelets } from '../src/runtime/kagelets/sync.ts'
import { kageletRows } from '../src/core/kagelets/kagelet.ts'
import type { ToSession } from '../src/runtime/protocol.ts'
import { fakeSdk } from '../src/runtime/tests/fake-sdk.ts'

export type Step =
  | { at: string }
  | { kagelet: string; schedule: string }
  | { job: { thread: string; id: string; cron: string; prompt: string } }
  | { tick: true }
  | { end: string; report: boolean; error?: string }
  | { stalls: true }
  | { task: { thread: string; from: 'owner' | 'teammate'; text: string } }
  | { call: { thread: string; tool: string; args: Record<string, unknown> } }

export type Evidence = { tasks: { key: string; text: string }[]; dms: string[]; calls: string[]; cuts: string[] }

const THREAD = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const laneOf = (name: string) => `CTEST1:1700000000.123456#side-kagelet-${name}`
const tick = () => new Promise(r => setTimeout(r, 5))

export function refuseLiveConfig(dir: string, home = homedir()) {
  const live = resolve(home, '.config/kage'), real = (p: string) => { try { return realpathSync(p) } catch { return resolve(p) } }
  if (real(dir) === real(live) || real(dir).startsWith(`${real(live)}/`)) throw new Error(`refused: an eval never runs against the live Kage config (${live})`)
}

type Clock = { now: number }

function world(dir: string, clock: Clock) {
  const store = openStore(join(dir, 'kage.db'))
  const ledgers = openLedgers(dir, () => new Date(clock.now).toISOString())
  let n = 0
  const runs = runEvents(ledgers, () => `t${++n}`, () => clock.now)
  const sdk = fakeSdk()
  const ev: Evidence = { tasks: [], dms: [], calls: [], cuts: [] }
  const last = new Map<string, number>()
  const slack = { chat: { postMessage: async () => ({ ts: '9.1' }) }, reactions: { add: async () => {} }, users: { info: async () => ({}) } }
  let d!: Dispatcher<ToSession>
  let routes!: ReturnType<typeof kageletRoutes>
  let grants = new Map<string, string[]>()
  const toSession = (key: string, task: Task): Delivery => {
    const r = d.task(key, task, clock.now)
    if (r !== 'failed') {
      ev.tasks.push({ key, text: task.content })
      last.set(key, clock.now)
      runs.start(key, task.scheduled ? `scheduled ${task.job ?? ''}` : 'task', { fresh: !!task.scheduled })
    }
    return r
  }
  const s = sdkSessions({
    sdk: { query: sdk.query as any, createSdkMcpServer, tool }, hub: () => d,
    tools: (_key, send, approve, turn) => sessionTools({ title: 'Kage', owner: () => 'UOWNER', bot: slack as any, user: slack as any, botDm: () => 'DBOT', dir, ledgers, send, memory: { own: join(dir, 'own'), owner: join(dir, 'owner') }, approve, turn, settings: { set: () => {} } }),
    hasTranscript: () => false, toHub: () => {}, options: { cwd: dir, settingSources: [] }, ownerMemory: join(dir, 'owner'), envFile: join(dir, 'env'), codeDir: dir, restartMs: 10,
    grantOf: key => grants.get(key),
    onResult: (key, _total, _resumed, limited, error) => { last.set(key, clock.now); routes.ended(key, 0, '', clock.now, limited, error) },
  })
  d = new Dispatcher<ToSession>(s.runner, { max: 10, idleMs: 3_600_000, connectMs: 60_000, evictMs: 60_000, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })
  const schedules = scheduler({ store, deliver: toSession, failed: t => ev.dms.push(`failed: ${t.meta.place}`), ready: key => d.ready(key), trusted: () => true, now: () => clock.now,
    job: { end: () => {}, freshEvery: () => 0, carryCount: () => 0, carryChars: () => 0, laneDefault: () => false, posted: () => '', project: dir } })
  const kagelets = join(dir, 'kagelets')
  const sync = (now: number) => { grants = syncKagelets(readKagelets(kagelets), store, now, () => {}) }
  const manager = kageletManager({ dir: kagelets, max: 10, ledgers, sync, runNow: (id, now) => schedules.runNow(id, now), store, log: () => {} })
  const incidents = kageletIncidents({
    store, perHour: () => 5, stallMs: () => 20 * 60_000,
    retryable: name => !!kageletRows(readKagelets(kagelets), { runs: '', costs: '', now: 0 }).find(r => r.name === name)?.cron,
    retry: (name, lead, now) => { schedules.runNow(`kagelet-${name}`, now, lead) }, pause: () => {}, say: t => ev.dms.push(t),
    last: () => ({ words: '', report: '' }),
    live: () => [...grants.keys()].map(key => ({ key, busy: d.ready(key) === 'busy', last: last.get(key) ?? 0, trace: runs.of(key)?.trace })),
    cut: key => { ev.cuts.push(key); d.endThread(key, true) },
  })
  routes = kageletRoutes({ dir: kagelets, store, ledgers, runs, deliver: toSession, granted: key => grants.has(key), idle: () => true, paused: () => undefined, log: () => {}, done: incidents.ended })
  const proc = (key: string) => [...sdk.runs].reverse().find(r => r.options.sessionId === d.saved()[key] || r.options.resume === d.saved()[key])
  return { clock, store, runs, ev, d, s, schedules, manager, incidents, toSession, proc }
}
type World = ReturnType<typeof world>

async function apply(w: World, st: Step) {
  const { clock, store, runs, ev, schedules, manager, incidents, toSession, proc } = w
  if ('at' in st) clock.now = Date.parse(st.at)
  else if ('kagelet' in st) await manager.manage({ action: 'save', name: st.kagelet, thread: THREAD, schedule: st.schedule, tools: ['WebFetch'], job: `Job of ${st.kagelet}.`, why: 'eval' }, clock.now, async () => true)
  else if ('job' in st) {
    const [chat, thread] = st.job.thread.split(':') as [string, string]
    store.seen(st.job.thread, { connector: 'slack', chat, thread, kind: 'channel' }, `#${chat}`, clock.now)
    const no = schedules.add(st.job.thread, { id: st.job.id, cron: st.job.cron, prompt: st.job.prompt, recurring: true }, clock.now)
    if (no) throw new Error(no)
  } else if ('tick' in st) schedules.tick(clock.now)
  else if ('end' in st) {
    const key = st.end.includes(':') ? st.end : laneOf(st.end)
    if (st.report) runs.emit(key, 'report', 'ok')
    proc(key)?.emit({ type: 'result', total_cost_usd: 0, ...st.error && { is_error: true, subtype: st.error } })
  } else if ('stalls' in st) incidents.stalls(clock.now)
  else if ('task' in st) {
    const [chat, thread] = st.task.thread.split(':') as [string, string]
    store.seen(st.task.thread, { connector: 'slack', chat, thread, kind: 'channel' }, `#${chat}`, clock.now)
    const body = { content: st.task.from === 'owner' ? `Task from the owner: ${st.task.text}` : `Teammate task (UTESTMATE1, Sam Test, not the owner): ${st.task.text}`,
      meta: { channel: chat, thread_ts: thread, place: `#${chat}`, permalink: '' }, origin: { channel: chat, ts: thread } }
    toSession(st.task.thread, st.task.from === 'owner' ? taskAsOwner(body) : taskAsOther(body))
  } else if ('call' in st) {
    const run = proc(st.call.thread)
    if (!run) throw new Error(`no session for ${st.call.thread}`)
    ev.calls.push(await callKage(run, st.call.tool, st.call.args))
  }
}

export async function scenario(steps: Step[]): Promise<Evidence> {
  const dir = mkdtempSync(join(tmpdir(), 'kage-eval-'))
  refuseLiveConfig(dir)
  const w = world(dir, { now: Date.parse('2026-11-14T09:00:00Z') })
  for (const st of steps) {
    await apply(w, st)
    await tick()
  }
  for (const k of Object.keys(w.d.saved())) w.s.runner.stop(k)
  w.store.close()
  rmSync(dir, { recursive: true, force: true })
  return w.ev
}

async function callKage(run: { options: any }, name: string, args: Record<string, unknown>) {
  const server = run.options.mcpServers.kage.instance
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'eval', version: '1' })
  try {
    await server.connect(b)
    await client.connect(a)
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[] }
    return r.content[0]!.text
  } finally { await client.close(); await server.close() }
}
