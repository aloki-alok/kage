import { existsSync } from 'node:fs'
import { askHub, DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'
import { hasKagelet, kageletsDir, pauseKagelet } from '../runtime/kagelets/files.ts'
import { errVoice } from './voice.ts'

if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot stop a thread. The owner runs kage stop in their own terminal, or writes "@kage stop" in the thread.'); process.exit(1) }
const args = process.argv.slice(2)
const resume = args.includes('--resume')
const name = args.filter(a => a !== '--now' && a !== '--resume').join(' ')
const KAGELETS = kageletsDir(DIR)
if (hasKagelet(KAGELETS, name)) { console.log(pauseKagelet(KAGELETS, name, !resume)); process.exit(0) }
if (resume) { console.error(`There is no kagelet named "${name}". kage list shows them.`); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(`${DIR}/router.sock`)) { console.error(errVoice.says("I'm not running. Start me with kage start.")); process.exit(1) }
const cut = args.includes('--now')
const other = args.find(a => a.startsWith('--') && a !== '--now')
if (other) { console.error(`kage stop <thread> takes --now, not ${other}. Bare kage stop ${other} stops the whole hub.`); process.exit(1) }
const { key, place } = await pickThread(args.filter(a => a !== '--now').join(' '), false)
const r = await askHub<{ text?: string }>({ type: 'end', key, cut }).catch((e: Error) => {
  console.error(errVoice.says(e.message === 'down' ? "I'm not running." : "I'm not answering. If I run older code, kage restart picks up kage stop <thread>."))
  return process.exit(1)
})
if (!r.text) { console.error('The hub runs older code: kage restart picks up kage stop <thread>.'); process.exit(1) }
console.log(`${place}: ${r.text}`)
