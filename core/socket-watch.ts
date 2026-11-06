// When to restart the Slack socket by hand. The client reconnects on its own, but its wait grows
// with every failure and a failed reconnect start can leave it down for good, with the hub up and
// deaf. Only the connection state counts: a quiet workspace at night is not a dead socket.

export type SocketVerdict = 'ok' | 'wait' | 'restart' | 'restart and tell'

export function socketWatch(o: { downMs: number }) {
  let up = false
  let downSince: number | undefined   // undefined before the first check or connection
  let restarts = 0
  return {
    connected() { up = true; downSince = undefined; restarts = 0 },
    down(now: number) { if (up || downSince === undefined) downSince = now; up = false },
    // Each restart gets downMs of its own to work. The owner hears once, when the second one failed.
    check(now: number): SocketVerdict {
      if (up) return 'ok'
      downSince ??= now
      if (now - downSince < o.downMs) return 'wait'
      downSince = now
      return ++restarts === 2 ? 'restart and tell' : 'restart'
    },
  }
}
