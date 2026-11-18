export type Channel = 'messenger' | 'instagram' | 'facebook_comment'
export type MetaEvent =
  | { kind: 'message'; channel: 'messenger' | 'instagram'; pageId: string; user: string; id: string; text: string; at: number; adId?: string }
  | { kind: 'echo'; channel: 'messenger' | 'instagram'; pageId: string; user: string; id: string; appId?: string; at: number }
  | { kind: 'comment'; channel: 'facebook_comment'; pageId: string; user: string; name?: string; id: string; postId: string; parentId?: string; text: string; at: number }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export function metaEvents(body: unknown): MetaEvent[] {
  const b = obj(body)
  const channel = b.object === 'page' ? 'messenger' : b.object === 'instagram' ? 'instagram' : undefined
  if (!channel) return []
  const out: MetaEvent[] = []
  for (const e of list(b.entry).map(obj)) {
    const pageId = str(e.id)
    for (const m of list(e.messaging).map(obj)) {
      const ev = messaging(m, channel, pageId)
      if (ev) out.push(ev)
    }
    if (channel === 'messenger') for (const c of list(e.changes).map(obj)) {
      const ev = comment(c, pageId)
      if (ev) out.push(ev)
    }
  }
  return out
}

function messaging(m: Obj, channel: 'messenger' | 'instagram', pageId: string): MetaEvent | undefined {
  const at = Number(m.timestamp) || 0
  const msg = obj(m.message), postback = obj(m.postback)
  if (msg.is_echo) {
    const id = str(msg.mid)
    return id ? { kind: 'echo', channel, pageId, user: str(obj(m.recipient).id), id, ...(msg.app_id ? { appId: str(msg.app_id) } : {}), at } : undefined
  }
  const id = str(msg.mid) || str(postback.mid)
  const text = (str(msg.text) || str(postback.title)).trim()
  if (!id || !text) return undefined
  const adId = str(obj(m.referral).ad_id) || str(obj(msg.referral).ad_id) || str(obj(postback.referral).ad_id)
  return { kind: 'message', channel, pageId, user: str(obj(m.sender).id), id, text, at, ...(adId ? { adId } : {}) }
}

function comment(c: Obj, pageId: string): MetaEvent | undefined {
  const v = obj(c.value), from = obj(v.from)
  if (c.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add') return undefined
  const user = str(from.id), id = str(v.comment_id), text = str(v.message).trim()
  if (!user || user === pageId || !id || !text) return undefined
  const parentId = str(v.parent_id)
  return {
    kind: 'comment', channel: 'facebook_comment', pageId, user, ...(str(from.name) ? { name: str(from.name) } : {}),
    id, postId: str(v.post_id), ...(parentId ? { parentId } : {}), text, at: (Number(v.created_time) || 0) * 1000,
  }
}
