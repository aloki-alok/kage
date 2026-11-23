import { existsSync, statSync, watch } from 'node:fs'
import { basename } from 'node:path'
import { checkSettings, diff, registryOf, type Config, type Secrets } from '../core/config.ts'
import type { AllowLists, Reloaded } from '../core/settings.ts'
import { files, readSettings } from './config-files.ts'
import { ownerLines } from '../core/messages.ts'
import { logRef } from './log.ts'

export type Settings = { config: Config; secrets: Secrets }
export type ConfigEvent = 'config.live' | 'config.restart' | 'config.refused'

export function configWatcher(o: {
  envFile: string
  boot: Settings
  log: (line: string) => void
  apply: (l: AllowLists) => void
  event: (kind: ConfigEvent, keys: string[]) => void
  tell: (text: string) => void
  restartWanted: (yes: boolean) => void
  debounceMs?: number
}) {
  let last = o.boot, count = 0, announced = '', told = ''
  const lists = (s: Settings) => ({ 'people.teammates': (s.config.people?.teammates ?? []).map(t => ({ ...t, id: t.user ?? logRef(t.email!), email: t.email && logRef(t.email) })), 'people.agents': registryOf(s.config).filter(e => e.kind === 'agent') })
  type Key = keyof ReturnType<typeof lists>

  function check(): Reloaded {
    count++
    let next: Settings
    try { next = readSettings(o.envFile) } catch (e) { return refuse((e as Error).message, (e as { keys?: string[] }).keys ?? []) }
    const ok = checkSettings(next.config, next.secrets)
    if ('error' in ok) return refuse(ok.error, [])
    const cwd = next.config.harness?.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!)
    if (cwd && !(existsSync(cwd) && statSync(cwd).isDirectory())) return refuse('harness.cwd is not a folder that exists', ['harness.cwd'])
    told = ''
    const live = (Object.keys(lists(last)) as Key[]).filter(k => JSON.stringify(lists(last)[k]) !== JSON.stringify(lists(next)[k]))
    const changed = live.map(k => {
      const a = lists(last)[k].map(e => e.id), b = lists(next)[k].map(e => e.id)
      const parts = [b.filter(x => !a.includes(x)).length ? `added ${b.filter(x => !a.includes(x)).join(', ')}` : '', a.filter(x => !b.includes(x)).length ? `removed ${a.filter(x => !b.includes(x)).join(', ')}` : ''].filter(Boolean)
      return `${k}: ${parts.join(', ') || 'changed'}`
    })
    if (live.length) {
      o.apply({ teammates: ok.teammates, trusted: ok.trusted, emails: ok.emails, apps: ok.apps })
      o.event('config.live', live)
    }
    last = next
    const restart = diff(o.boot, next).restart
    if (restart.join() !== announced) {
      announced = restart.join()
      if (restart.length) o.event('config.restart', restart)
      o.restartWanted(restart.length > 0)
    }
    o.log(`config check ${count}: ${live.join(', ') || 'no people change'}${restart.length ? `; restarts once quiet for: ${restart.join(', ')}` : ''}`)
    return { changed, restart, count }
  }

  function refuse(reason: string, keys: string[]): Reloaded {
    o.log(`config check ${count} refused: ${reason}`)
    o.event('config.refused', keys)
    if (reason !== told) { told = reason; o.tell(ownerLines.settingsRejected(reason)) }
    return { refused: reason }
  }

  let timer: NodeJS.Timeout | undefined
  const names = new Set([basename(files(o.envFile).config), basename(files(o.envFile).secrets)])
  const w = watch(files(o.envFile).dir, { persistent: false }, (_, name) => {
    if (!name || !names.has(name)) return
    clearTimeout(timer)
    timer = setTimeout(() => { try { check() } catch (e) { o.log(`config check failed: ${e}`) } }, o.debounceMs ?? 300)
  })
  return { check, close: () => { clearTimeout(timer); w.close() } }
}
