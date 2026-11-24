const SLACK_CHANNELS: Record<string, string> = { D: 'dm', G: 'group', C: 'channel' }
const TOKENS: Record<string, string> = { bot: 'bot', owner: 'owner', card: 'bot', canvas: 'bot', people: 'owner' }

const channelType = (channel: string) => channel === 'whatsapp' ? channel : SLACK_CHANNELS[channel[0] ?? ''] ?? 'other'

export const postEvent = (kind: string, token: string, channel: string) =>
  ({ kind: 'post' as const, who: 'hub', trace: '', detail: `${kind} ${token} ${channelType(channel)}` })

export function postedEvent([channel = '', , by = '']: string[], kind?: string) {
  const token = TOKENS[by]
  if (!token) return undefined
  return postEvent(kind ?? (by === 'bot' || by === 'owner' ? 'reply' : by), token, channel)
}
