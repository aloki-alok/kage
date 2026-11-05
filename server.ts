#!/usr/bin/env node
// Kage session side: the Claude Code channel inside one thread's tmux pane. Serves the session's
// Kage tools (runtime/kage-tools.ts) over MCP stdio, takes tasks from the hub over a local socket,
// and relays permission prompts to the owner's DM.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { load, log } from './config.ts'
import type { ToSession } from './runtime/protocol.ts'
import { senderOf } from './core/gate.ts'
import { memoryDirs, senderFile } from './core/guards.ts'
import { sessionTools } from './runtime/kage-tools.ts'
import { schedulesIn } from './runtime/store.ts'

// Installed as a plugin, this server starts in every Claude Code session. Only the panes the
// router opens (KAGE_THREAD set) take tasks. Everywhere else, answer MCP and stay idle.
const THREAD = process.env.KAGE_THREAD
if (!THREAD) {
  await new Server({ name: 'kage', version: '0.4.0' }, { capabilities: {} }).connect(new StdioServerTransport())
  await new Promise(() => {})
}

const { ENV_FILE, Title, env, bot, user } = load()
const SOCK = `${dirname(ENV_FILE)}/router.sock`
process.on('unhandledRejection', e => log('unhandled', e))

let botDm = ''
let router: Socket | undefined
const unsentAsks: string[] = []   // approvals asked while the hub restarted: it learns them on reconnect
const kage = sessionTools({
  title: Title, bot, user, botDm: () => botDm, dir: dirname(ENV_FILE),
  memory: memoryDirs(process.env.HOME!, ENV_FILE, env),
  send: m => { if (!router?.writable) return false; router.write(JSON.stringify(m) + '\n') },   // a dead socket loses it
  // Writes go through the hub, which files them under this pane's thread; reading the store is safe.
  schedules: {
    // Done only once the store holds it: the hub may refuse it (logged there) or be restarting.
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
    // The router sends the yes or no back to this session only.
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
  // The private-data hook reads this. It must land before the task does, so a failure drops the task.
  const sender = senderFile(dirname(ENV_FILE), THREAD!)
  mkdirSync(dirname(sender), { recursive: true, mode: 0o700 })
  writeFileSync(sender, senderOf({ fromOwner: m.fromOwner === true, meta: m.meta }), { mode: 0o600 })
  kage.onTask(m)
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: m.content, meta: m.meta } })
}

// Connects to the router and stays connected: it reconnects after a router restart.
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

// Take tasks only once Claude Code has finished the MCP handshake and can receive them.
mcp.oninitialized = () => {
  user.auth.test().then(async me => {
    botDm = (await bot.conversations.open({ users: me.user_id! })).channel!.id!
    link()
  }).catch(e => { log('Slack auth failed', e?.data?.error ?? e); process.exit(1) })
}
await mcp.connect(new StdioServerTransport())
