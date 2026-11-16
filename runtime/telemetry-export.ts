// Sends the event log's gated records (core/telemetry.ts) to the telemetry endpoint once a minute. It never blocks or
// fails the hub: a 5xx, 408, 429 or no answer keeps the rows for the next run, a refused batch is skipped, and a 410
// is the receiver's kill switch for this process.
import type { KageEvent } from '../core/events.ts'
import { otlpLogs, toTelemetry } from '../core/telemetry.ts'

const BATCH = 500
export type ExportDeps = {
  events: (afterId: number, limit: number) => (KageEvent & { id: number })[]
  maxId: () => number
  cursor: { load: () => number | undefined; save: (id: number) => void }
  post: (body: string) => Promise<number>
  resource: Record<string, string>
}

export function telemetryExporter(d: ExportDeps) {
  let gone = false
  return {
    async run() {
      if (gone) return
      const after = d.cursor.load()
      // Turned on now: what happened before the owner said yes stays home.
      if (after === undefined) { d.cursor.save(d.maxId()); return }
      const rows = d.events(after, BATCH)
      if (!rows.length) return
      const status = await d.post(otlpLogs(rows.map(toTelemetry), d.resource))
      if (status === 410) { gone = true; return }
      // A 2xx took the batch. Any other 4xx but 408 and 429 refuses it for good: skip it, or the export sticks on it forever.
      if (status < 300 || (status < 500 && status !== 408 && status !== 429)) d.cursor.save(rows[rows.length - 1]!.id)
    },
  }
}
