// kage stop <link, place or key> [--now]: end one thread's session once its turn ends, or now. Its schedules keep
// running, and its next tag starts it again. Bare kage stop stops the whole hub (setup.sh).
import { askHub } from './home.ts'
import { pickThread } from './pick-thread.ts'

if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot stop a thread. The owner runs kage stop in their own terminal, or writes "@kage stop" in the thread.'); process.exit(1) }
const args = process.argv.slice(2)
const cut = args.includes('--now')
const { key, place } = await pickThread(args.filter(a => a !== '--now').join(' '))
const r = await askHub<{ text?: string }>({ type: 'end', key, cut }).catch((e: Error) => {
  console.error(e.message === 'down' ? 'Kage is not running.' : 'The hub does not answer. If it runs older code, kage restart picks up kage stop <thread>.')
  return process.exit(1)
})
if (!r.text) { console.error('The hub runs older code: kage restart picks up kage stop <thread>.'); process.exit(1) }
console.log(`${place}: ${r.text}`)
