// Dreaming: once a week, while nobody is working, Kage tidies its own memory and checks the owner's,
// read only. Copied from OpenClaw's dreaming and Hermes' curator: archive, never delete; keep a ledger
// of every move so one line can undo it.

const WEEK = 7 * 24 * 3600_000

// Due between 02:00 and 06:00 on the Mac's clock, a week after the last dream, with every session quiet.
export function dreamDue(now: number, last: number | undefined, quiet: boolean): boolean {
  const hour = new Date(now).getHours()
  return quiet && hour >= 2 && hour < 6 && (last === undefined || now - last >= WEEK)
}

export function dreamTask(m: { own: string; owner: string }): string {
  return [
    'Weekly dream. Nobody wrote a new message: the hub started this while every session was quiet.',
    `1. Your memory, ${m.own}: merge notes that say the same thing, and where two disagree keep the newer one. Move a note nobody needed for 30 days into ${m.own}/.archive/ with mv; never delete a file. Keep MEMORY.md in step with the files.`,
    `2. For every move, merge or edit, append one line to ${m.own}/.dream-ledger.tsv: ISO time, action, file, one-line reason.`,
    `3. The owner's memory, ${m.owner}, is read only for you. List files over 20 KB, index lines whose file is missing, and notes that contradict each other.`,
    '4. Reply here in at most 5 lines: what you changed in your memory, then what the owner should look at in theirs. Nothing changed and nothing found: one line saying so.',
  ].join('\n')
}
