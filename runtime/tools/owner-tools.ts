import { z } from 'zod'
import { settingTier } from '../../core/config.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

export function ownerTools(c: ToolContext): KageTool[] {
  const { o, Title, s, ownerActs, name } = c
  const tools: KageTool[] = []
  const meetbot = o.meetbot
  if (meetbot && !name && !o.dreaming) tools.push({
    name: 'meeting_join',
    description: `Send ${o.title}'s meeting bot into a Google Meet call by its link. It joins under a name that says it takes notes, posts one line in the call's chat, answers out loud when someone says ${o.title}, and the notes come to the owner's DM when the call ends. The host may need to admit it. Owner tasks only.`,
    shape: { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag'), link: s.describe('the Meet link, https://meet.google.com/abc-defg-hij') },
    async run(args) {
      if (!ownerActs(args)) return { isError: true, text: "refused: only the owner's own task sends the meeting bot" }
      const why = meetbot.join(String(args.link))
      o.event?.('tool', `meeting_join ${why ? 'refused' : 'ok'}`)
      return why ? { isError: true, text: `meeting bot: ${why}` } : { text: 'The meeting bot is joining. Tell the owner the host may need to admit it.' }
    },
  })
  if (!name && o.settings) tools.push({
    name: 'set_setting',
    description: `Change one ${Title} setting when the owner's own task asks for it: key is the dotted path in config.json (kagelets.dailyUsd, afk.model, connectors.voice.port) and value is JSON. Limits, models, AFK, Jev thresholds, ports and the browser block list apply at once. Anything that grants power (people, a command, a connector on, harness) puts a card in front of the owner first, and nothing changes without their yes. Tokens are never settable.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      key: s.describe('the dotted config.json key'),
      value: z.unknown().describe('the new value, as JSON'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; key: string; value: unknown }
      if (!ownerActs(a)) return { isError: true, text: "refused: only the owner's own task may change a setting" }
      if (a.key === 'jev.threshold' && !(typeof a.value === 'number' && a.value >= 0.3)) return { isError: true, text: 'refused: jev.threshold must be a number of 0.3 or more' }
      const tier = settingTier(a.key)
      if (tier === 'never') return { isError: true, text: `refused: ${a.key} is not a setting a session may change` }
      if (tier === 'power') {
        if (!o.approve) return { isError: true, text: `refused: ${a.key} needs the owner's yes on a card, and this session cannot show one. The owner runs kage set in their own terminal.` }
        if (!await o.approve('set_setting', `Change ${a.key} to ${JSON.stringify(a.value)}. This setting grants reach or runs code, so it needs your yes.`, { key: a.key, value: a.value })) return { isError: true, text: `The owner said no. ${a.key} is unchanged.` }
      }
      try { o.settings!.set(a.key, a.value) } catch (e) { return { isError: true, text: `not changed: ${(e as Error).message}` } }
      o.event?.('tool', `set_setting ${a.key}`)
      return { text: `Set ${a.key}. The hub applies it now, or restarts once every session is quiet.` }
    },
  })
  return tools
}
