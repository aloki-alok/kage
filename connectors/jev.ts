// The Jev call (rules in core/jev.ts). It fails open: on a timeout, an HTTP error or an answer it cannot read, the
// post is answered as before, and the loop guard (core/agents.ts) still caps an agent's turns. The log carries the
// score and the reason only, never the key or the post.
import { JEV_URL, jevChecks, jevRequest, jevVerdict, type JevConfig } from '../core/jev.ts'

export type JevCheck = (app: string, text: string) => Promise<{ reply: boolean; why: string }>

export function jevCheck(c: JevConfig, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): JevCheck {
  const go = o.fetch ?? fetch
  return async (app, text) => {
    if (!jevChecks(c, app)) return { reply: true, why: 'jev does not check this agent' }
    try {
      const r = await go(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(jevRequest(text, c.model)),
        signal: AbortSignal.timeout(o.timeoutMs ?? 4000),
      })
      if (!r.ok) return { reply: true, why: `jev answered HTTP ${r.status}, answering anyway` }
      const v = jevVerdict(await r.json(), c.threshold)
      if ('error' in v) return { reply: true, why: `jev: ${v.error}, answering anyway` }
      return { reply: v.reply, why: `jev needs_reply ${v.score.toFixed(2)} (threshold ${c.threshold})` }
    } catch (e) {
      return { reply: true, why: `jev failed (${(e as Error).name}), answering anyway` }
    }
  }
}
