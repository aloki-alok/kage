import type { ChatMessage } from './prompt.ts'

export type ModelSettings = { baseUrl: string; model: string; timeoutMs: number }

export const modelRequest = (m: ModelSettings, messages: ChatMessage[], json: boolean) => ({
  model: m.model,
  messages,
  ...(json ? { response_format: { type: 'json_object' } } : {}),
})

export async function chat(m: ModelSettings, key: string, messages: ChatMessage[], json: boolean): Promise<string> {
  const res = await fetch(`${m.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(modelRequest(m, messages, json)),
    signal: AbortSignal.timeout(m.timeoutMs),
  })
  if (!res.ok) throw new Error(`model answered ${res.status}`)
  const body = await res.json() as { choices?: { message?: { content?: string } }[] }
  return body.choices?.[0]?.message?.content ?? ''
}
