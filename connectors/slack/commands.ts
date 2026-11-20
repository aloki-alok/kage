import type { SocketModeClient } from '@slack/socket-mode'
import type { WebClient } from '@slack/web-api'
import { execFile } from 'node:child_process'
import { log } from '../../runtime/log.ts'
import { commandRequest, type CommandRequest } from '../../core/commands.ts'
import { splitForSlack } from '../../core/outbound.ts'
import type { Ledgers } from '../../runtime/ledger.ts'

export function listenForCommands(socket: SocketModeClient, o: { user: WebClient; team: string; commands: Map<string, string>; ledgers: Ledgers }) {
  let chain = Promise.resolve()
  socket.on('slash_commands', async ({ body, ack }) => {
    const r = body as CommandRequest & { response_url?: string }
    const v = commandRequest(r, { team: o.team, commands: o.commands })
    if (!v.ok) return ack({ response_type: 'ephemeral', text: v.reply })
    const who = (await o.user.users.info({ user: r.user_id! }).catch(() => null))?.user as { is_restricted?: boolean; is_ultra_restricted?: boolean; is_stranger?: boolean } | undefined
    if (!who || who.is_restricted || who.is_ultra_restricted || who.is_stranger) return ack({ response_type: 'ephemeral', text: 'This command works only for full members of this workspace.' })
    const n = v.numbers.length
    await ack({ response_type: 'in_channel', text: `Looking up ${n} number${n > 1 ? 's' : ''}. This takes about ${Math.ceil((n * 6 + 15) / 60)} min, after any lookup already running.` })
    o.ledgers.add('commands', [r.user_id!, r.command ?? '', String(n)])
    const post = (text: string) => fetch(r.response_url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'in_channel', text }) })
      .then(res => { if (!res.ok) log('command reply refused', res.status) })
    chain = chain.then(() => new Promise<void>(done => {
      execFile('node', [v.script, ...v.numbers], { timeout: (n * 15 + 120) * 1000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        const why = err && ((stderr.match(/^\w*Error: .*$/m)?.[0] ?? '') || (err.killed ? 'timed out' : String(err)))
        if (err) log('command failed', r.command, r.user_id, why)
        const chunks = stdout.trim() ? splitForSlack(stdout.trim(), 2800) : []
        const parts = chunks.slice(0, 4).map(p => '```' + p + '```')
        if (chunks.length > 4) parts.push(`${chunks.length - 4} more parts not shown. Send fewer numbers per run.`)
        if (why) parts.push(`Lookup failed${chunks.length ? ' partway' : ''}: ${why}`)
        if (!parts.length) parts.push('No results.')
        parts.slice(0, 5).reduce((p, t) => p.then(() => post(t)), Promise.resolve()).catch(e => log('command reply failed', e)).finally(done)
      })
    }))
  })
}
