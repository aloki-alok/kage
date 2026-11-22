export type SmsProvider = 'twilio' | 'telnyx'
export type SmsSent = { id: string } | { error: string; auth: boolean; again: boolean }
export type SmsSend = (to: string, from: string, body: string) => Promise<SmsSent>

const TWILIO_API = 'https://api.twilio.com/2010-04-01'
const TELNYX_API = 'https://api.telnyx.com/v2/messages'

export function smsSender(o: {
  provider: SmsProvider; statusUrl: string
  accountSid?: string; twilioAuthToken?: string; telnyxApiKey?: string
  fetch?: typeof fetch
}): SmsSend {
  const call = o.fetch ?? fetch
  const request = o.provider === 'twilio'
    ? (to: string, from: string, body: string) => call(`${TWILIO_API}/Accounts/${encodeURIComponent(o.accountSid ?? '')}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${o.accountSid}:${o.twilioAuthToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body, StatusCallback: o.statusUrl }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    : (to: string, from: string, body: string) => call(TELNYX_API, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.telnyxApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, text: body, webhook_url: o.statusUrl }),
      signal: AbortSignal.timeout(15_000),
    })
  return async (to, from, body) => {
    const res = await request(to, from, body)
    const json = await res.json().catch(() => undefined) as Record<string, any> | undefined
    if (res.ok) {
      const id = o.provider === 'twilio' ? json?.sid : json?.data?.id
      return typeof id === 'string' && id ? { id } : { error: 'no-id', auth: false, again: false }
    }
    const code = o.provider === 'twilio' ? json?.code : Array.isArray(json?.errors) ? json.errors[0]?.code : undefined
    const auth = res.status === 401 || res.status === 403
    return { error: code === undefined || code === null ? `http-${res.status}` : String(code), auth, again: auth || res.status === 429 || res.status >= 500 }
  }
}
