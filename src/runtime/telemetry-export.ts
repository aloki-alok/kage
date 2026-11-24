import type { KageEvent } from '../core/events.ts'
import { otlpLogs, telemetryRecords } from '../core/telemetry.ts'

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
      const records = telemetryRecords(rows)
      const status = records.length ? await d.post(otlpLogs(records, d.resource)) : 200
      if (status === 410) { gone = true; return }
      if (status < 300 || (status < 500 && status !== 408 && status !== 429)) d.cursor.save(rows[rows.length - 1]!.id)
    },
  }
}
