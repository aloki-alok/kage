export type Say = (text: string) => Promise<boolean>
type OwnerApp = 'slack' | 'whatsapp'

export function ownerChannel(o: { pick: () => OwnerApp | undefined; slack: Say; whatsapp?: Say }) {
  return {
    async say(text: string): Promise<boolean> {
      if (o.pick() === 'whatsapp' && o.whatsapp && await o.whatsapp(text).catch(() => false)) return true
      return o.slack(text)
    },
  }
}
