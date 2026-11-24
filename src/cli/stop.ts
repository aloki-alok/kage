import { existsSync } from 'node:fs'
import { askHub, DIR, inTerminal, notRunning } from './home.ts'
import { refusedLine } from '../core/board.ts'
import { pickThread } from './pick-thread.ts'
import { hasKagelet, kageletsDir, pauseKagelet } from '../runtime/kagelets/files.ts'
import { errVoice } from './voice.ts'

if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot stop a thread. The owner runs kage stop in their own terminal, or writes "@kage stop" in the thread.'); process.exit(1) }
const args = process.argv.slice(2)
const resume = args.includes('--resume'), kageletOnly = resume || args.includes('--kagelet'), threadOnly = args.includes('--thread')
const TARGET_FLAGS = ['--resume', '--kagelet', '--thread']
const name = args.filter(a => a !== '--now' && !TARGET_FLAGS.includes(a)).join(' ')
const KAGELETS = kageletsDir(DIR)
if (!threadOnly && hasKagelet(KAGELETS, name)) { console.log(pauseKagelet(KAGELETS, name, !resume)); process.exit(0) }
if (kageletOnly) { console.error(`There is no kagelet named "${name}". kage kagelet list shows them.`); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(`${DIR}/router.sock`)) notRunning()
const cut = args.includes('--now')
const other = args.find(a => a.startsWith('--') && a !== '--now' && !TARGET_FLAGS.includes(a))
if (other) { console.error(`kage stop <thread> takes --now, not ${other}. Bare kage stop ${other} stops the whole hub.`); process.exit(1) }
const { key, place } = await pickThread(name, false)
const r = await askHub<{ text?: string; refused?: string }>({ type: 'end', key, cut }).catch((e: Error) => {
  if (e.message === 'down') return notRunning()
  console.error(errVoice.says("I'm not answering. If I run older code, kage restart picks up kage thread stop <thread>."))
  return process.exit(1)
})
if (typeof r.refused === 'string') { console.error(refusedLine(r.refused, inTerminal)); process.exit(1) }
if (!r.text) { console.error('The hub runs older code: kage restart picks up kage thread stop <thread>.'); process.exit(1) }
console.log(`${place}: ${r.text}`)
