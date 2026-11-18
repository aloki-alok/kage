import { log } from '../runtime/log.ts'
import { afkRequest, afkVerdict, jevChecks, jevRequest, jevVerdict, reactionVerdict, triageRequest, triageSkips, triageVerdict, type JevConfig, type Urgency } from '../core/jev.ts'

type JevAnswer = { json: unknown } | { status: number } | { failed: string }
async function jevPost(c: JevConfig, body: () => unknown, go: typeof fetch, timeoutMs: number): Promise<JevAnswer> {
  try {
    const r = await go(c.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return r.ok ? { json: await r.json() } : { status: r.status }
  } catch (e) {
    return { failed: (e as Error).name }
  }
}

export type JevCheck = (app: string, text: string) => Promise<{ reply: boolean; why: string }>

export function jevCheck(c: JevConfig, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): JevCheck {
  const go = o.fetch ?? fetch
  return async (app, text) => {
    if (!jevChecks(c, app)) return { reply: true, why: 'jev does not check this agent' }
    const a = await jevPost(c, () => jevRequest(text, c.model), go, o.timeoutMs ?? 4000)
    if ('failed' in a) return { reply: true, why: `jev failed (${a.failed}), answering anyway` }
    if ('status' in a) return { reply: true, why: `jev answered HTTP ${a.status}, answering anyway` }
    const v = jevVerdict(a.json, c.threshold)
    if ('error' in v) return { reply: true, why: `jev: ${v.error}, answering anyway` }
    return { reply: v.reply, why: `jev needs_reply ${v.score.toFixed(2)} (threshold ${c.threshold})` }
  }
}

export type Triage = (who: string, sender: 'owner' | 'other', text: string, o: { hasFiles: boolean; inThread: boolean; context?: () => Promise<string> }) => Promise<{ pick: 'session' | 'react'; why: string; reaction?: ReturnType<typeof reactionVerdict> }>

export function jevTriage(c: JevConfig, emit: (who: string, detail: string) => void, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Triage {
  const go = o.fetch ?? fetch
  return async (who, sender, text, skips) => {
    const t0 = Date.now()
    const done = (pick: 'session' | 'react', why: string, reaction = { key: 'none', emoji: null as string | null, confidence: 0 }) => {
      emit(who, `${pick}: ${why}, reaction ${reaction.key} ${reaction.confidence.toFixed(2)}, ${Date.now() - t0} ms`)
      return { pick, why, reaction }
    }
    const skip = triageSkips(text, skips)
    if (skip) return done('session', `no jev call, ${skip}`)
    let context = ''
    try { context = await skips.context?.() ?? '' } catch { return done('session', 'conversation unavailable') }
    const a = await jevPost(c, () => triageRequest(text, c.model, context), go, o.timeoutMs ?? 4000)
    if ('failed' in a) return done('session', `jev failed (${a.failed})`)
    if ('status' in a) return done('session', `jev answered HTTP ${a.status}`)
    const v = triageVerdict(a.json, sender)
    if ('error' in v) return done('session', `jev: ${v.error}`)
    return done(v.pick, `${sender} react ${v.score.toFixed(2)}`, reactionVerdict(a.json))
  }
}

export type JevAfk = (o: { owner: string; place: string; from: string; convo: string }) => Promise<{ urgency: Urgency; waits: boolean; lookup: boolean } | undefined>

export function jevAfk(c: JevConfig, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): JevAfk {
  const go = o.fetch ?? fetch
  return async input => {
    const a = await jevPost(c, () => afkRequest(input, c.model), go, o.timeoutMs ?? 8000)
    if ('failed' in a) return void log(`afk: jev failed (${a.failed}), using the Claude triage`)
    const v = 'status' in a ? { error: `HTTP ${a.status}` } : afkVerdict(a.json)
    if ('error' in v) return void log(`afk: jev ${v.error}, using the Claude triage`)
    return v
  }
}
