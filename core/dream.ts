// Dreaming: every night, while nobody is working, Kage reads the day's threads for lessons, tidies its
// own memory and checks the owner's, read only. Copied from OpenClaw's dreaming and Hermes' curator:
// archive, never delete; keep a ledger of every move so one line can undo it.

// 12 hours, not 24: a dream that started at 05:50 must not push the next night's past 06:00.
const GAP = 12 * 3600_000

// Due between 02:00 and 06:00 on the Mac's clock, once a night, with every session quiet.
export function dreamDue(now: number, last: number | undefined, quiet: boolean): boolean {
  const hour = new Date(now).getHours()
  return quiet && hour >= 2 && hour < 6 && (last === undefined || now - last >= GAP)
}

// The sessions whose transcript changed since `since`, leaving out the dream's own lane.
export function threadsSince(sessions: Record<string, string>, mtime: (id: string) => number | undefined, since: number): { key: string; id: string }[] {
  return Object.entries(sessions)
    .filter(([key, id]) => !key.endsWith('#side-dream') && (mtime(id) ?? 0) >= since)
    .map(([key, id]) => ({ key, id }))
}

export function dreamTask(m: { own: string; owner: string }, threads: { place: string; file: string }[], since: string): string {
  const read = threads.length
    ? [
        `1. Today's threads. Read what happened in each one after ${since}: the tasks (\`jq -r 'select(.type=="user" and .timestamp>"${since}") | .message.content | if type=="string" then . else (map(select(.type=="text").text) | join("\\n")) end | select(length>0)' <file>\`).`,
        ...threads.map(t => `   • ${t.place}: ${t.file}`),
        `   Look for times the owner corrected you, said what they prefer, or repeated an ask, and for a method a thread had to work out. For each lasting lesson, update the note in ${m.own} that covers it, or write a new feedback note with the why. Skip one-off facts, anything already saved, and anything private to a teammate.`,
      ]
    : ['1. No threads moved since the last dream, so there is nothing new to learn from.']
  return [
    'Nightly dream. Nobody wrote a new message: the hub started this while every session was quiet.',
    ...read,
    `2. Your memory, ${m.own}: merge notes that say the same thing, and where two disagree keep the newer one. Move a note nobody needed for 30 days into ${m.own}/.archive/ with mv; never delete a file. Keep MEMORY.md in step with the files.`,
    `3. For every new note, move, merge or edit, append one line to ${m.own}/.dream-ledger.tsv: ISO time, action, file, one-line reason.`,
    `4. The owner's memory, ${m.owner}, is read only for you. List files over 20 KB, index lines whose file is missing, and notes that contradict each other.`,
    '5. Reply here in at most 5 lines: what you learned from the threads, what you changed in your memory, then what the owner should look at in theirs. Nothing changed and nothing found: one line saying so.',
  ].join('\n')
}
