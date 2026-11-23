#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { load } from '../src/hub/config.ts'
import { log } from '../src/runtime/log.ts'
import type { ToSession } from '../src/runtime/protocol.ts'
import { withoutInvisible } from '../src/core/gate.ts'
import { memoryDirs } from '../src/core/guards.ts'
import { sessionTools } from '../src/runtime/kage-tools.ts'
import { openLedgers } from '../src/runtime/ledger.ts'
import { paneTurn } from '../src/runtime/pane-turn.ts'
import { schedulesIn } from '../src/runtime/store.ts'
import { foreignAgentTags } from '../src/core/agents.ts'

const THREAD = process.env.KAGE_THREAD
if (!THREAD) {
  await new Server({ name: 'kage', version: '0.4.0' }, { capabilities: {} }).connect(new StdioServerTransport())
  await new Promise(() => {})
}

const { ENV_FILE, Title, TRUSTED_APPS, config, bot, user } = load()
const SOCK = `${dirname(ENV_FILE)}/router.sock`
process.on('unhandledRejection', e => log('unhandled', e))

let botDm = ''
let router: Socket | undefined
const unsentAsks: string[] = []
const turn = paneTurn({
  dir: dirname(ENV_FILE), thread: THREAD!,
  show: m => {
    kage.onTask(m)
    mcp.notification({ method: 'notifications/claude/channel', params: { content: withoutInvisible(m.content), meta: m.meta } }).catch(e => log('task failed', e))
  },
})
let ownerId = ''
const kage = sessionTools({
  title: Title, bot, user, botDm: () => botDm, dir: dirname(ENV_FILE), ledgers: openLedgers(dirname(ENV_FILE)),
  memory: memoryDirs(process.env.HOME!, ENV_FILE, config.harness),
  turnSender: turn.sender,
  foreignAgents: () => config.askOtherAgents ? [] : foreignAgentTags(TRUSTED_APPS, ownerId),
  send: m => { if (!router?.writable) return false; router.write(JSON.stringify(m) + '\n') },
  schedules: {
    async add(j) {
      router?.write(JSON.stringify({ type: 'schedule', ...j }) + '\n')
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200))
        if (schedulesIn(`${dirname(ENV_FILE)}/kage.db`, THREAD!).some(s => s.id === j.id)) return
      }
      return 'Kage did not take this schedule (it may be restarting, or the thread cannot hold more). Try again in a minute.'
    },
    remove: id => { router?.write(JSON.stringify({ type: 'unschedule', id }) + '\n') },
    list: () => schedulesIn(`${dirname(ENV_FILE)}/kage.db`, THREAD!),
  },
})

const mcp = new Server(
  { name: 'kage', version: '0.4.0' },
  {
    capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
    instructions: kage.instructions,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: kage.tools.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) as { type: 'object' } })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const tool = kage.tools.find(t => t.name === req.params.name)
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`)
  const args = z.object(tool.shape).safeParse(req.params.arguments ?? {})
  if (!args.success) return { isError: true, content: [{ type: 'text', text: z.prettifyError(args.error) }] }
  const r = await tool.run(args.data)
  return { isError: r.isError, content: [{ type: 'text', text: r.text }] }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params: p }) => {
    if (router?.writable) router.write(JSON.stringify({ type: 'permission', id: p.request_id }) + '\n')
    else unsentAsks.push(p.request_id)
    await kage.askOwner({ id: p.request_id, tool: p.tool_name, description: p.description, preview: p.input_preview })
      .catch(e => log('permission prompt failed', e?.data?.error ?? e))
  },
)

async function fromRouter(m: ToSession) {
  if (m.type === 'verdict') {
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: m.request_id, behavior: m.behavior } })
    return
  }
  turn.arrive(m)
}

function link() {
  const s = connect(SOCK)
  let buf = ''
  s.on('connect', () => {
    router = s
    s.write(JSON.stringify({ type: 'hello', key: THREAD }) + '\n')
    for (const id of unsentAsks.splice(0)) s.write(JSON.stringify({ type: 'permission', id }) + '\n')
  })
  s.on('data', chunk => {
    buf += chunk
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try { fromRouter(JSON.parse(line)).catch(e => log('task failed', e)) } catch (e) { log('bad line from router', e) }
    }
  })
  s.on('error', () => {})
  s.on('close', () => { if (router === s) router = undefined; setTimeout(link, 2000) })
}

mcp.oninitialized = () => {
  user.auth.test().then(async me => {
    ownerId = me.user_id!
    botDm = (await bot.conversations.open({ users: me.user_id! })).channel!.id!
    link()
  }).catch(e => { log('Slack auth failed', e?.data?.error ?? e); process.exit(1) })
}
await mcp.connect(new StdioServerTransport())
