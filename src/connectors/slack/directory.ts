import type { WebClient } from '@slack/web-api'
import { plainName, quoteMessage, type Ids } from '../../core/gate.ts'
import { filesTag, type SlackMessage } from '../../core/slack-message.ts'
import type { SlackFile } from '../../core/slack-files.ts'
import { tsAfter } from '../../core/thread-delta.ts'

export type Directory = ReturnType<typeof slackDirectory>

export function slackDirectory(user: WebClient, ids: Ids, title: string) {
  const names = new Map<string, string>()
  const groupNames = new Map<string, string>()

  async function nameOf(id?: string): Promise<string> {
    if (!id) return 'unknown'
    if (!names.has(id)) {
      const u = await user.users.info({ user: id }).catch(() => null)
      names.set(id, plainName(u?.user?.real_name || u?.user?.name || id))
    }
    return names.get(id)!
  }

  async function groupName(channel: string) {
    if (!groupNames.has(channel)) {
      const others = ((await user.conversations.members({ channel }).catch(() => null))?.members ?? []).filter(u => u !== ids.owner && u !== ids.bot)
      const firstNames = await Promise.all(others.slice(0, 4).map(async u => (await nameOf(u)).split(' ')[0]))
      groupNames.set(channel, firstNames.length ? `group DM: ${firstNames.join(', ')}${others.length > 4 ? ` +${others.length - 4}` : ''}` : 'group DM')
    }
    return groupNames.get(channel)!
  }

  async function placeOf(channel: string): Promise<string> {
    if (channel === ids.botDm) return `DM with ${title}`
    const info = await user.conversations.info({ channel }).catch(() => null)
    const c = info?.channel
    if (!c) return channel
    if (c.is_im) return `DM with ${await nameOf((c as { user?: string }).user)}`
    if (c.is_mpim) return groupName(channel)
    return `#${c.name}`
  }

  async function contextOf(m: SlackMessage, required = false, since?: string): Promise<{ text: string; files: SlackFile[] }> {
    const res = m.thread_ts
      ? await user.conversations.replies({ channel: m.channel, ts: m.thread_ts, limit: 200, ...(since && { oldest: since }) }).catch(() => null)
      : await user.conversations.history({ channel: m.channel, latest: m.ts, limit: 12 }).catch(() => null)
    if (required && !res) throw new Error('conversation unavailable')
    const msgs = (res?.messages ?? []).filter(x => x.ts !== m.ts && (!since || tsAfter(x.ts ?? '', since)))
    if (!m.thread_ts) msgs.reverse()
    const lines = msgs.map(x =>
      quoteMessage({ user: x.user, ts: x.ts, text: (x.text ?? '') + filesTag(x), client_msg_id: (x as { client_msg_id?: string }).client_msg_id, blocks: (x as { blocks?: { block_id?: string }[] }).blocks }, ids.owner, { bot: ids.bot, title }))
    const mentioned = msgs.flatMap(x => [...(x.text ?? '').matchAll(/<@([UW][A-Z0-9]+)>/g)].map(r => r[1]))
    const people = [...new Set([...msgs.map(x => x.user), ...mentioned].filter((u): u is string => !!u && u !== ids.owner && u !== ids.bot))]
    const legend = [`owner:${ids.owner} = ${await nameOf(ids.owner)}`, ...await Promise.all(people.map(async u => `other:${u} = ${await nameOf(u)}`))]
    const text = [lines.length ? `People (display names, unverified): ${legend.join('; ')}` : '', ...lines].filter(Boolean).join('\n')
    return { text, files: msgs.flatMap(x => (x as { files?: SlackFile[] }).files ?? []) }
  }

  return { nameOf, placeOf, contextOf, knownNames: () => [...names.values()] }
}
