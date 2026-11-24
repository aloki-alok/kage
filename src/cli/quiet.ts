import { waitForQuiet, type Wait } from '../core/quiet.ts'
import { askHub, placeNamer } from './home.ts'

process.on('SIGINT', () => { console.error('\nStopped waiting. Kage takes new messages again within 10 s.'); process.exit(130) })
const command = process.argv[2] === 'stop' ? 'stop' : 'restart'
const r = await waitForQuiet({
  ask: () => askHub<{ waiting?: Wait[]; refused?: string }>({ type: 'quiesce' }).then(a => {
    if (typeof a.refused === 'string') return { refused: a.refused }
    if (!a.waiting) throw new Error('silent')
    return a.waiting
  }),
  say: line => console.log(line),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  placeOf: placeNamer(),
  cut: process.argv.includes('--cut-running'),
  command,
})
if (r === 'refused' || r === 'silent') process.exit(1)
