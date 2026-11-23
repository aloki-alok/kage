import { log } from '../runtime/log.ts'
import { waCards } from '../runtime/wa-cards.ts'
import { waCardNote } from '../core/whatsapp.ts'

type Verdict = 'allow' | 'deny'

export function whatsappCards(o: { channel: () => string | undefined; say?: (text: string) => Promise<boolean>; name: string; verdict: (id: string, behavior: Verdict) => boolean }) {
  const waCardCodes = waCards(), waSay = o.say
  return {
    send(c: { id: string; tool: string; description: string; place: string; preview: string }) {
      if (o.channel() !== 'whatsapp' || !waSay) return
      const code = waCardCodes.open(c.id)
      const note = waCardNote({ ...c, code }, o.name)
      if (!note) { waCardCodes.take(code); return }
      void waSay(note).then(sent => { if (!sent) waCardCodes.take(code) })
    },
    answer(a: { code: string; behavior: Verdict }) {
      const id = waCardCodes.take(a.code)
      const done = !!id && o.verdict(id, a.behavior)
      log('whatsapp card answer', a.code, id ? (done ? a.behavior : 'already answered') : 'no such card')
      void waSay?.(!id ? `No card waits on ${a.code}.` : done ? (a.behavior === 'allow' ? 'Approved.' : 'Denied.') : 'That card was already answered.')
    },
  }
}
