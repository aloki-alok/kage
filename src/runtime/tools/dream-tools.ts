import { z } from 'zod'
import type { Dismissal, DreamLesson } from '../../core/dream.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

export function dreamTools(c: ToolContext): KageTool[] {
  const apply = c.o.dreamLessons
  if (!apply) return []
  return [{
    name: 'dream_lessons',
    description: 'Send tonight\'s lessons, all in one call. The hub keeps a lesson only when two or more of tonight\'s threads show it with exact quotes and its confidence is high enough, writes the kept ones into your memory, and logs every drop with its reason in the dream ledger.',
    shape: {
      lessons: z.array(z.object({
        kind: z.enum(['new', 'outdated']),
        file: z.string().describe('a plain note name such as merge-style.md'),
        text: z.string().describe('the lesson and its why, or why the note is now wrong'),
        evidence: z.array(z.object({ key: z.string().describe('a thread key from the task'), quote: z.string().describe('exact words from that thread') })),
        confidence: z.number().min(0).max(1),
        flag: z.string().optional().describe('the id of the open knowledge flag this lesson answers'),
      })),
      dismiss: z.array(z.object({ flag: z.string(), reason: z.string() })).optional().describe('open knowledge flags that do not hold, each with the reason'),
    },
    async run(args) {
      const a = args as { lessons: DreamLesson[]; dismiss?: Dismissal[] }
      return { text: apply(a.lessons, a.dismiss) }
    },
  }]
}
