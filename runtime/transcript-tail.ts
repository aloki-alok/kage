// Following a Claude Code session transcript (JSONL) on disk: read what was added since the last read.
// core/transcript.ts turns each line into one a person can follow.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

// The complete lines written after `offset`, and where the next read starts. A line still being
// written stays for the next read. A missing or unreadable file reads as nothing; a file shorter
// than the offset was replaced, so it is read from the top.
export function newLines(file: string, offset: number): { lines: string[]; offset: number } {
  let buf: Buffer
  try {
    const size = statSync(file).size
    if (size < offset) offset = 0
    if (size === offset) return { lines: [], offset }
    const fd = openSync(file, 'r')
    try {
      buf = Buffer.alloc(size - offset)
      buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, offset))
    } finally { closeSync(fd) }
  } catch { return { lines: [], offset } }
  const end = buf.lastIndexOf(10)   // "\n"; never inside a multi-byte character
  if (end < 0) return { lines: [], offset }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean), offset: offset + end + 1 }
}
