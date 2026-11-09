// Local slash commands never reach a Claude session: the hub runs the configured script with the
// parsed phone numbers as its only arguments. Results post in the channel; refusals go to the caller alone.
import type { SocketModeClient } from '@slack/socket-mode'
import type { WebClient } from '@slack/web-api'
import { execFile } from 'node:child_process'
import { log } from '../config.ts'
import { commandRequest, type CommandRequest } from '../core/commands.ts'
import { splitForSlack } from '../core/outbound.ts'
import type { Ledgers } from '../runtime/ledger.ts'

// ponytail: one run at a time on this Mac; move the handler to a server if the team leans on it.
export function listenForCommands(socket: SocketModeClient, o: { user: WebClient; team: string; commands: Map<string, string>; ledgers: Ledgers }) {
  let chain = Promise.resolve()
  socket.on('slash_commands', async ({ body, ack }) => {
    const r = body as CommandRequest & { response_url?: string }
    const v = commandRequest(r, { team: o.team, commands: o.commands })
    if (!v.ok) return ack({ response_type: 'ephemeral', text: v.reply })
    // Guests share the workspace id, so the team check alone lets them in.
    const who = (await o.user.users.info({ user: r.user_id! }).catch(() => null))?.user as { is_restricted?: boolean; is_ultra_restricted?: boolean; is_stranger?: boolean } | undefined
    if (!who || who.is_restricted || who.is_ultra_restricted || who.is_stranger) return ack({ response_type: 'ephemeral', text: 'This command works only for full members of this workspace.' })
    const n = v.numbers.length
    await ack({ response_type: 'in_channel', text: `Looking up ${n} number${n > 1 ? 's' : ''}. This takes about ${Math.ceil((n * 6 + 15) / 60)} min, after any lookup already running.` })
    o.ledgers.add('commands', [r.user_id!, r.command ?? '', String(n)])
    const post = (text: string) => fetch(r.response_url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'in_channel', text }) })
      .then(res => { if (!res.ok) log('command reply refused', res.status) })
    chain = chain.then(() => new Promise<void>(done => {
      // About 6 s per number; the margin covers Chrome start-up.
      execFile('node', [v.script, ...v.numbers], { timeout: (n * 15 + 120) * 1000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        // A thrown Error ends stderr with "Node.js vXX", so take the Error line itself.
        const why = err && ((stderr.match(/^\w*Error: .*$/m)?.[0] ?? '') || (err.killed ? 'timed out' : String(err)))
        if (err) log('command failed', r.command, r.user_id, why)
        // Slack allows 5 posts per response_url: 4 of results, 1 kept for the failure line.
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
