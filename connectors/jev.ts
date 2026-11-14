// The Jev call (rules in core/jev.ts). It fails open: on a timeout, an HTTP error or an answer it cannot read, the
// post is answered as before, and the loop guard (core/agents.ts) still caps an agent's turns. The log carries the
// score and the reason only, never the key or the post.
import { JEV_URL, jevChecks, jevRequest, jevVerdict, triageRequest, triageSkips, triageVerdict, type JevConfig } from '../core/jev.ts'

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

export type Triage = (who: string, sender: 'owner' | 'other', text: string, hasFiles: boolean) => Promise<{ pick: 'session' | 'react'; why: string }>

// Intake triage (rules in core/jev.ts). who: the thread. Every call ends in an event with the pick and the score, never the text (ADR 0010).
// It fails open: a timeout, an HTTP error or an answer it cannot read is `session`.
export function jevTriage(c: JevConfig, emit: (who: string, detail: string) => void, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Triage {
  const go = o.fetch ?? fetch
  // Threads that got a reaction: the next tagged message there ("do it") always starts a session. ponytail: in memory, a restart forgets it and Jev decides again.
  const reacted = new Set<string>()
  return async (who, sender, text, hasFiles) => {
    const done = (pick: 'session' | 'react', why: string) => {
      if (pick === 'react') reacted.add(who)
      emit(who, `${pick}: ${why}`)
      return { pick, why }
    }
    if (reacted.delete(who)) return done('session', 're-tag after a reaction')
    const skip = triageSkips(text, hasFiles)
    if (skip) return done('session', `no jev call, ${skip}`)
    try {
      const r = await go(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(triageRequest(text, c.model)),
        signal: AbortSignal.timeout(o.timeoutMs ?? 4000),
      })
      if (!r.ok) return done('session', `jev answered HTTP ${r.status}`)
      const v = triageVerdict(await r.json(), sender)
      if ('error' in v) return done('session', `jev: ${v.error}`)
      return done(v.pick, `${sender} react ${v.score.toFixed(2)}`)
    } catch (e) {
      return done('session', `jev failed (${(e as Error).name})`)
    }
  }
}
