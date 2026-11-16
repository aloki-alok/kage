// The cheap reviewer on the hub (ADR 0018): one isolated model call that may let a low-stakes held shell step of a
// tools: all kagelet run, at kagelets.release review only, at most kagelets.reviewsPerDay per kagelet a day.
import { heldCommand } from '../core/held.ts'
import { reviewable, reviewAsk, reviewRuns } from '../core/held-review.ts'
import { shellGrant } from '../core/kagelets.ts'

type Lane = { name: string; tools: string[]; job: string; objective?: { objective: string } }

export function kageletReview(o: {
  settings: () => { release: 'rules' | 'review'; perDay: number; model: string }
  kagelet: (key: string) => Lane | undefined
  ask: (a: { model: string; system: string; prompt: string }) => Promise<string>
  event: (key: string, detail: string) => void   // the kind only, never the command (ADR 0010)
  today: () => string
}) {
  // ponytail: counted in memory, so a restart resets the day's count; keep it in the store if restarts matter.
  const released = new Map<string, number>()
  return async (key: string, command: string): Promise<boolean> => {
    const s = o.settings(), k = o.kagelet(key)
    if (s.release !== 'review' || !k || !shellGrant(k.tools) || !reviewable(command)) return false
    const day = `${k.name} ${o.today()}`
    // The slot is taken before the call, so parallel calls in one turn cannot pass the cap; a HOLD gives it back.
    if ((released.get(day) ?? 0) >= s.perDay) return false
    released.set(day, (released.get(day) ?? 0) + 1)
    const kind = heldCommand(command)!
    const runs = await o.ask({ model: s.model, ...reviewAsk({ kagelet: k.name, job: k.job, objective: k.objective?.objective, command, kind }) }).then(reviewRuns, () => false)
    if (!runs) released.set(day, released.get(day)! - 1)
    o.event(key, `${runs ? 'released' : 'kept'} by reviewer: ${kind}`)
    return runs
  }
}
