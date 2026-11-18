import type { WebClient } from '@slack/web-api'
import type { Conversation } from '../core/conversations.ts'
import type { Ids } from '../core/gate.ts'
import type { SlackMessage } from '../core/slack-message.ts'
import type { Hub } from './slack.ts'

export const sayAsOwner = (o: { user: WebClient; ids: Ids; hub: Pick<Hub, 'take'>; hear: (m: SlackMessage, source: string) => Promise<void> }) =>
  async (text: string, at?: { channel: string; thread_ts: string; kind: Conversation['kind'] }) => {
    const { ids } = o
    const channel = at?.channel ?? ids.botDm
    const r = await o.user.chat.postMessage({ channel, ...(at && { thread_ts: at.thread_ts }), text })
    const m: SlackMessage = {
      channel, ts: r.ts!, user: ids.owner, fromSocket: true, ...(at && { thread_ts: at.thread_ts }),
      channel_type: !at ? 'im' : at.kind === 'dm' ? 'im' : at.kind === 'group' ? 'mpim' : 'channel',
      text: channel === ids.botDm ? text : `<@${ids.bot}> ${text}`,
    }
    const source = `slack-say:${channel}:${m.ts}`
    if (o.hub.take(source, 'slack', JSON.stringify(m))) void o.hear(m, source)
    return { channel, ts: m.ts }
  }
