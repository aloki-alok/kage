import { readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { campaignReport, smsSegments, usNumber, type CampaignAction } from '../../core/sms.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'
import type { SmsStore } from '../sms-store.ts'

export type SmsCampaigns = Pick<SmsStore, 'createCampaign' | 'campaign' | 'campaigns' | 'move' | 'report'>

type Args = { channel: string; thread_ts: string; action: string; campaign?: number; name?: string; body?: string; numbers?: string[]; file?: string }
const MOVE_ACTIONS: Record<string, CampaignAction> = { pause: 'pause', resume: 'resume', cancel: 'cancel' }

function phonesFromFile(folder: string, file: string): { phones: string[]; bad: number } | string {
  if (basename(file) !== file) return `refused: ${file} is not a file name in this thread's files folder`
  let text: string
  try {
    const path = realpathSync(join(folder, file))
    if (!path.startsWith(realpathSync(folder) + '/')) return `refused: ${file} is outside this thread's files folder`
    text = readFileSync(path, 'utf8')
  } catch { return `no file named ${file} in this thread's files folder` }
  const phones: string[] = []
  let bad = 0
  for (const line of text.split(/\r?\n/).filter(l => l.trim())) {
    const phone = line.split(',').map(cell => usNumber(cell.trim().replace(/^"|"$/g, ''))).find(Boolean)
    if (phone) phones.push(phone)
    else bad++
  }
  return { phones, bad }
}

function create(c: ToolContext, sms: SmsCampaigns, a: Args): Result {
  if (!a.name || !a.body) return { isError: true, text: 'create needs a name and a body' }
  if (!/\bstop\b/i.test(a.body)) return { isError: true, text: 'refused: the text must tell people how to opt out, such as "Reply STOP to opt out."' }
  let phones: string[]
  let badLine: string
  if (a.file) {
    const read = phonesFromFile(c.filesOf(a.channel, a.thread_ts), a.file)
    if (typeof read === 'string') return { isError: true, text: read }
    phones = read.phones
    badLine = `${read.bad} lines with no US number`
  } else {
    const parsed = (a.numbers ?? []).map(n => usNumber(n))
    phones = parsed.filter((p): p is string => !!p)
    badLine = `${parsed.length - phones.length} not a US number`
  }
  if (!phones.length) return { isError: true, text: `no US numbers to text (${badLine})` }
  const made = sms.createCampaign({ name: a.name, body: a.body, thread: `${a.channel}:${a.thread_ts}`, phones })
  c.o.event?.('tool', 'sms_campaign create')
  return { text: `Draft campaign ${made.id}: ${made.added} contacts, ${made.repeated} repeated, ${badLine}. Nothing sends until launch and the owner's yes.` }
}

async function launch(c: ToolContext, sms: SmsCampaigns, id: number): Promise<Result> {
  const k = sms.campaign(id)
  if (!k) return { isError: true, text: `no campaign ${id}` }
  if (k.state !== 'draft') return { isError: true, text: `campaign ${id} is ${k.state}, and only a draft launches` }
  if (!c.o.approve) return { isError: true, text: 'refused: a launch needs the owner\'s yes on a card, and this session cannot show one' }
  const contacts = sms.report(id)?.contacts ?? 0
  const { segments } = smsSegments(k.body)
  const card = `Text campaign ${JSON.stringify(k.name)} to ${contacts} contacts, ${segments} segment${segments === 1 ? '' : 's'} each, sent 2pm to 8pm Eastern:\n${k.body}`
  if (!await c.o.approve('sms_campaign', card, { campaign: id, contacts })) return { isError: true, text: `The owner said no. Campaign ${id} stays a draft.` }
  const moved = sms.move(id, 'launch')
  if (!moved) return { isError: true, text: `campaign ${id} changed while the card was open, and did not launch` }
  c.o.event?.('tool', 'sms_campaign launch')
  return { text: `Campaign ${id} is sending. Reports come to this thread.` }
}

function act(c: ToolContext, sms: SmsCampaigns, a: Args): Result | Promise<Result> {
  if (a.action === 'create') return create(c, sms, a)
  if (a.action === 'list') return { text: sms.campaigns(20).map(k => `#${k.id} ${k.name} (${k.state})`).join('\n') || 'No campaigns yet.' }
  const id = Number(a.campaign)
  if (!Number.isInteger(id)) return { isError: true, text: `${a.action} needs a campaign number` }
  if (a.action === 'launch') return launch(c, sms, id)
  if (a.action === 'report') {
    const numbers = sms.report(id)
    return numbers ? { text: campaignReport(numbers) } : { isError: true, text: `no campaign ${id}` }
  }
  const step = MOVE_ACTIONS[a.action]
  if (!step) return { isError: true, text: `unknown action ${a.action}` }
  const now = sms.campaign(id)?.state
  if (!now) return { isError: true, text: `no campaign ${id}` }
  const moved = sms.move(id, step)
  if (!moved) return { isError: true, text: `campaign ${id} is ${now}, so it cannot ${a.action}` }
  c.o.event?.('tool', `sms_campaign ${a.action}`)
  return { text: `Campaign ${id} is ${moved}.` }
}

export function smsTools(c: ToolContext): KageTool[] {
  const { o, s, ownerActs, name } = c
  const sms = o.sms
  if (!sms || name || o.dreaming) return []
  return [{
    name: 'sms_campaign',
    description: 'Text campaigns to US numbers from the owner\'s SMS number. create makes a draft from numbers or a CSV in this thread\'s files folder, and never sends. launch shows the owner a card with the count and the text, and sends only on their yes, 2pm to 8pm Eastern. pause, resume and cancel move a campaign, report gives its delivery numbers, list names the latest. The text must say how to opt out (Reply STOP). Owner tasks only.',
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      action: z.enum(['create', 'launch', 'pause', 'resume', 'cancel', 'report', 'list']),
      campaign: z.number().int().optional().describe('the campaign number, for every action but create and list'),
      name: s.optional().describe('create: a short name for the campaign'),
      body: s.optional().describe('create: the text every contact gets, with how to opt out'),
      numbers: z.array(z.string()).optional().describe('create: US phone numbers'),
      file: s.optional().describe("create: a CSV file name in this thread's files folder, one contact per line; a header line counts as a line with no number"),
    },
    async run(args) {
      if (!ownerActs(args)) return { isError: true, text: "refused: only the owner's own task runs a text campaign" }
      return act(c, sms, args as Args)
    },
  }]
}
