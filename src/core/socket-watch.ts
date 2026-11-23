
type SocketVerdict = 'ok' | 'wait' | 'restart' | 'restart and tell'

export function socketWatch(o: { downMs: number }) {
  let up = false
  let downSince: number | undefined
  let restarts = 0
  return {
    connected() { up = true; downSince = undefined; restarts = 0 },
    down(now: number) { if (up || downSince === undefined) downSince = now; up = false },
    check(now: number): SocketVerdict {
      if (up) return 'ok'
      downSince ??= now
      if (now - downSince < o.downMs) return 'wait'
      downSince = now
      return ++restarts === 2 ? 'restart and tell' : 'restart'
    },
  }
}
