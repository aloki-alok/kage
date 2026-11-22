import { heldCommand } from '../../core/held.ts'
import { reviewable, reviewAsk, reviewRuns } from '../../core/held-review.ts'
import { shellGrant } from '../../core/kagelets/kagelet.ts'

type Lane = { name: string; tools: string[]; job: string; objective?: { objective: string } }
export type Review = { release: boolean; said?: 'run' | 'hold' }

export function kageletReview(o: {
  settings: () => { release: 'rules' | 'review' | 'shadow'; perDay: number; model: string }
  kagelet: (key: string) => Lane | undefined
  ask: (a: { model: string; system: string; prompt: string }) => Promise<string>
  event: (key: string, detail: string) => void
  today: () => string
}) {
  const counted = new Map<string, number>()
  return async (key: string, command: string): Promise<Review> => {
    const s = o.settings(), k = o.kagelet(key)
    if (s.release === 'rules' || !k || !shellGrant(k.tools) || !reviewable(command)) return { release: false }
    const day = `${k.name} ${o.today()}`
    if ((counted.get(day) ?? 0) >= s.perDay) return { release: false }
    counted.set(day, (counted.get(day) ?? 0) + 1)
    const kind = heldCommand(command)!
    const said = await o.ask({ model: s.model, ...reviewAsk({ kagelet: k.name, job: k.job, objective: k.objective?.objective, command, kind }) }).then(out => reviewRuns(out) ? 'run' as const : 'hold' as const, () => undefined)
    const release = s.release === 'review' && said === 'run'
    if (s.release === 'review' && !release) counted.set(day, counted.get(day)! - 1)
    o.event(key, s.release === 'shadow' ? `shadow reviewer ${said ? `would ${said}` : 'failed'}: ${kind}` : `${release ? 'released' : 'kept'} by reviewer: ${kind}`)
    return { release, ...said && { said } }
  }
}
