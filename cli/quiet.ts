// kage restart and kage stop run this first: the hub drains, and this waits until no thread is mid-turn
// (core/quiet.ts). --cut-running drains and names what it cuts instead of waiting.
import { waitForQuiet, type Wait } from '../core/quiet.ts'
import { askHub, placeNamer } from './home.ts'

process.on('SIGINT', () => { console.error('\nStopped waiting. Kage takes new messages again within 10 s.'); process.exit(130) })
await waitForQuiet({
  ask: () => askHub<{ waiting?: Wait[] }>({ type: 'quiesce' }).then(a => { if (!a.waiting) throw new Error('silent'); return a.waiting }),
  say: line => console.log(line),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  placeOf: placeNamer(),
  cut: process.argv.includes('--cut-running'),
})
