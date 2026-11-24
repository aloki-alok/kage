export type Say = (text: string) => Promise<boolean>
type OwnerApp = 'slack' | 'whatsapp'

export function ownerChannel(o: { pick: () => OwnerApp | undefined; slack: Say; whatsapp?: Say; onWhatsapp?: (text: string) => void }) {
  return {
    async say(text: string): Promise<boolean> {
      if (o.pick() === 'whatsapp' && o.whatsapp && await o.whatsapp(text).catch(() => false)) { o.onWhatsapp?.(text); return true }
      return o.slack(text)
    },
  }
}
