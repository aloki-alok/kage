import { DatabaseSync } from 'node:sqlite'
import { matchThreads, slackLinkKey, type ThreadRow } from '../core/conversations.ts'
import { RELAY_CHANNEL } from '../core/ssm.ts'
import { DIR } from './home.ts'

function threadRows(): ThreadRow[] {
  const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
  const rows = db.prepare(`select s.key, coalesce(c.place, s.key) as place, c.chat, c.agent_dm from sessions s
    left join conversations c using (key) order by c.last_seen desc nulls last`).all() as ThreadRow[]
  db.close()
  return rows
}

export function pickChannel(arg: string): string {
  if (RELAY_CHANNEL.test(arg)) return arg
  const want = arg.trim().replace(/^#/, '').toLowerCase()
  const found = [...new Map(threadRows().flatMap(r => r.chat && RELAY_CHANNEL.test(r.chat) && r.place.replace(/^#/, '').toLowerCase() === want ? [[r.chat, r.place] as const] : [])).entries()]
  if (found.length === 1) return found[0]![0]
  console.error(found.length ? `${found.length} channels are named "${arg}". Give its id instead:` : `Kage has no thread in a channel named "${arg}". Give its id (C… or G…), or tag Kage there first.`)
  found.forEach(([chat, place]) => console.error(`  ${place}   (${chat})`))
  process.exit(found.length ? 2 : 1)
}

export async function pickThread(arg: string, lanes = true): Promise<{ key: string; place: string }> {
  const rows = threadRows()
  let found = matchThreads(lanes ? rows : rows.filter(r => !r.key.includes('#')), arg)
  const linked = slackLinkKey(arg)
  if (linked && !found.length) {
    console.error(`Kage has no session for that thread (${linked}). Tag Kage in the thread to start one, or leave the link out to pick from the list.`)
    process.exit(1)
  }
  if (found.length !== 1) {
    const list = (found.length ? found : rows).slice(0, 20)
    console.error(arg ? `${found.length} threads match "${arg}". Pick one (newest first):` : 'Pick a thread (newest first):')
    list.forEach((r, i) => console.error(`  ${String(i + 1).padStart(2)}. ${r.place}   (${r.key})`))
    if (!process.stdin.isTTY) process.exit(2)
    process.stderr.write('Number: ')
    const n = Number(await new Promise<string>(r => process.stdin.once('data', b => r(String(b).trim()))))
    process.stdin.pause()
    if (!list[n - 1]) { console.error('No such number.'); process.exit(1) }
    found = [list[n - 1]!]
  }
  return found[0]!
}
