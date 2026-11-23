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
      if (after === undefined) { d.cursor.save(d.maxId()); return }
      const rows = d.events(after, BATCH)
      if (!rows.length) return
      const status = await d.post(otlpLogs(rows.map(toTelemetry), d.resource))
      if (status === 410) { gone = true; return }
      if (status < 300 || (status < 500 && status !== 408 && status !== 429)) d.cursor.save(rows[rows.length - 1]!.id)
    },
  }
}
