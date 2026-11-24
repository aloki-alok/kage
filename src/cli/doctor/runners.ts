import { runnerLines } from '../../core/doctor.ts'
import { parseKagelet } from '../../core/kagelets/kagelet.ts'
import { kageletsDir, readKagelets } from '../../runtime/kagelets/files.ts'
import { schedulesIn } from '../../runtime/store.ts'
import { dir, onPath, type Group } from './context.ts'

export const runners: Group = () => runnerLines({ opencode: onPath('opencode'), jobs: schedulesIn(`${dir}/kage.db`), kagelets: readKagelets(kageletsDir(dir)).flatMap(f => { const k = parseKagelet(f.name, f.text); return 'error' in k ? [] : [k] }) })
