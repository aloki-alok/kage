import type { MetaEvent } from './meta.ts'

const GRAPH = 'https://graph.facebook.com/v25.0'
export type GraphRequest = { path: string; body: Record<string, unknown> }

export function replyRequests(ev: MetaEvent, text: string, publicLine: string): GraphRequest[] {
  if (ev.kind === 'message') return [{ path: '/me/messages', body: { recipient: { id: ev.user }, messaging_type: 'RESPONSE', message: { text } } }]
  if (ev.kind !== 'comment') return []
  const out: GraphRequest[] = [{ path: '/me/messages', body: { recipient: { comment_id: ev.id }, message: { text } } }]
  if (publicLine) out.push({ path: `/${ev.id}/comments`, body: { message: publicLine } })
  return out
}

export async function graphPost(token: string, r: GraphRequest): Promise<void> {
  const res = await fetch(`${GRAPH}${r.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(r.body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: number; error_subcode?: number } }
    throw new Error(`graph ${r.path.split('/')[1]} answered ${res.status} code ${e.error?.code ?? '?'}/${e.error?.error_subcode ?? '-'}`)
  }
}
