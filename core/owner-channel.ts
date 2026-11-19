export type Say = (text: string) => Promise<boolean>
export const ownerChannel = (o: { pick: () => 'slack' | 'whatsapp' | undefined; slack: Say; whatsapp?: Say }) => ({ say: o.slack })
