import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../runtime/log.ts'
import { oneLine } from '../core/text.ts'
import { repliesIn } from '../core/transcript.ts'
import { bearerOk, hourCap, listen, readBody } from './webhook.ts'

export type Siri = { token?: string | null; on?: boolean; port?: number; perHour?: number; waitSeconds?: number }
type SpokenReply = { text: string; asksOwner?: string }
type Options = {
  siri: Siri
  start: (words: string) => Promise<string>
  asking: (key: string) => boolean
  waitMs?: number
}
type Answer = { status: number; state: 'answered' | 'asks' | 'approval' | 'working' | 'failed' | 'busy' | 'bad'; say: string }

const MAX_WORDS = 2000
const MAX_SPOKEN = 450
const TITLE_WORDS = 8

export const siriWords = (words: string) =>
  `From Siri, heard, not typed: ${oneLine(words)}\n`
  + '(Siri reads your reply aloud if it comes within a few seconds: then answer in one to three plain sentences, no markdown, no links. '
  + 'For longer work, do it and post the result here when done. If you need something from me, ask one specific question. '
  + 'Misheard words are easy to act on, so a one-way step still needs my yes in this thread or on a card.)'

export const siriTitle = (words: string) => {
  const all = oneLine(words).split(' ')
  return `${all.slice(0, TITLE_WORDS).join(' ').replace(/[.,;:!?]+$/, '')}${all.length > TITLE_WORDS ? '...' : ''}`
}

export function spoken(text: string): string {
  const plain = oneLine(text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, 'a link')
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_~`>]/g, ''))
  if (plain.length <= MAX_SPOKEN) return plain
  const tail = ' The rest is in Slack.'
  const cut = plain.slice(0, MAX_SPOKEN - tail.length)
  const end = cut.lastIndexOf('. ')
  return `${end > 0 ? cut.slice(0, end + 1) : cut}${tail}`
}

export function turnReplies(transcript: string): SpokenReply[] {
  try { return readFileSync(transcript, 'utf8').split('\n').flatMap(repliesIn) } catch { return [] }
}

function outcome(replies: SpokenReply[]): Answer {
  const ask = replies.find(r => r.asksOwner)?.asksOwner
  if (ask) return { status: 200, state: 'asks', say: `I need one answer first: ${spoken(ask)} Reply in Slack.` }
  const text = replies.map(r => r.text).join(' ')
  return { status: 200, state: 'answered', say: text.trim() ? spoken(text) : 'Done. The details are in Slack.' }
}

export function connectSiri(o: Options) {
  const { token, on, port, perHour, waitSeconds } = o.siri
  if (on === false || !token) return undefined
  const waitMs = o.waitMs ?? (waitSeconds || 20) * 1000
  const cap = hourCap(perHour || 30)
  const waiting = new Map<string, (r: SpokenReply[]) => void>()

  async function ask(words: string): Promise<Answer> {
    if (cap.full(Date.now())) return { status: 429, state: 'busy', say: 'That is a lot of asks this hour. Try again later.' }
    cap.add(Date.now())
    let key: string
    try { key = await o.start(words) } catch (e) {
      log('siri could not start', e)
      return { status: 502, state: 'failed', say: 'I could not save that. Try again in a moment.' }
    }
    const replies = await new Promise<SpokenReply[] | undefined>(done => {
      const timer = setTimeout(() => { waiting.delete(key); done(undefined) }, waitMs)
      waiting.set(key, r => { clearTimeout(timer); waiting.delete(key); done(r) })
    })
    return o.asking(key) ? { status: 200, state: 'approval', say: 'That needs your approval. The card is in Slack.' }
      : replies ? outcome(replies)
      : { status: 200, state: 'working', say: `I saved "${siriTitle(words)}". I'll reply in Slack.` }
  }
  const timed = async (words: string) => {
    const at = Date.now(), a = await ask(words)
    log(`siri ask: ${a.state} in ${Date.now() - at} ms`)
    return a
  }

  const { server, listening } = listen(siriRoute(token, timed), port ?? 8794)
  void listening.then(p => log(`siri on: 127.0.0.1:${p}/ask`), e => log('siri could not listen', e))
  return {
    listening,
    ended: (key: string, read: () => SpokenReply[]) => waiting.get(key)?.(read()),
    address: () => (server.address() as AddressInfo).address,
    async close() {
      server.closeAllConnections()
      await new Promise(r => server.close(r))
    },
  }
}

function siriRoute(token: string, ask: (words: string) => Promise<Answer>) {
  const send = (res: ServerResponse, a: Answer) => res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify({ state: a.state, say: a.say }))
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!bearerOk(req.headers.authorization, token)) { res.writeHead(401).end(); return }
    if (req.method !== 'POST' || req.url !== '/ask') { res.writeHead(404).end(); return }
    const body = await readBody(req, 16 * 1024)
    let words = ''
    try { words = String((JSON.parse(body?.toString('utf8') ?? '') as { text?: unknown })?.text ?? '').trim() } catch { words = '' }
    if (!words || words.length > MAX_WORDS) { send(res, { status: 400, state: 'bad', say: 'I did not catch any words. Try again.' }); return }
    send(res, await ask(words))
  }
}
