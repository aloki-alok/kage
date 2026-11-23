import { closeSync, openSync, readSync, statSync } from 'node:fs'

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
  const end = buf.lastIndexOf(10)
  if (end < 0) return { lines: [], offset }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean), offset: offset + end + 1 }
}
