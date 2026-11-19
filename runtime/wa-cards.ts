import { randomInt } from 'node:crypto'

const DAY = 24 * 3600_000

export function waCards(o: { random?: () => number; now?: () => number } = {}) {
  const random = o.random ?? (() => randomInt(10_000) / 10_000), now = o.now ?? Date.now
  const open = new Map<string, { id: string; at: number }>()
  const prune = () => { for (const [code, c] of open) if (now() - c.at > DAY) open.delete(code) }
  return {
    open(id: string): string {
      prune()
      let code = ''
      for (let i = 0; i < 50 && (!code || open.has(code)); i++) code = String(Math.floor(random() * 10_000)).padStart(4, '0')
      open.set(code, { id, at: now() })
      return code
    },
    take(code: string): string | undefined {
      prune()
      const c = open.get(code)
      open.delete(code)
      return c?.id
    },
  }
}
