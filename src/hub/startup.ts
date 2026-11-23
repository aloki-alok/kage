import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { log } from '../runtime/log.ts'
import { readSettings } from '../runtime/config-files.ts'
import { unknownNames } from '../core/config.ts'
import { clearUpdatedFrom, updatedNote } from '../runtime/auto-update.ts'
import { checkScopes } from '../runtime/slack-scopes.ts'
import { scopeDm } from '../core/slack-scopes.ts'
import { ownerLines } from '../core/messages.ts'
import type { scheduler } from '../runtime/scheduler.ts'
import type { Store } from '../runtime/store.ts'

export function importCrons(dir: string, panes: number, schedules: Pick<ReturnType<typeof scheduler>, 'adopt'>, tell: (text: string) => void) {
  const CRONS = `${dir}/crons-import.json`
  if (existsSync(CRONS) && panes) log('crons-import.json waits: panes are still running, so their jobs are still alive')
  else if (existsSync(CRONS)) {
    try {
      const f = JSON.parse(readFileSync(CRONS, 'utf8'))
      const r = schedules.adopt(f.jobs, f.ranUntil)
      log(`adopted ${r.adopted.length} cron jobs from the panes${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
      renameSync(CRONS, `${CRONS}.imported`)
    } catch (e) {
      log('crons-import.json is unreadable, moved to .bad', e)
      renameSync(CRONS, `${CRONS}.bad`)
      tell(ownerLines.cronImportBad())
    }
  }
}

export function startupNotes(o: { dir: string; code: string; version: string; envFile: string; store: Pick<Store, 'load' | 'save'>; say: (text: string) => Promise<boolean>; tokens: Parameters<typeof checkScopes>[0] }) {
  const { dir: DIR, store } = o
  const updated = updatedNote(DIR, o.code, o.version)
  if (updated) { log(updated); void o.say(updated).then(sent => { if (sent) clearUpdatedFrom(DIR) }) }
  const unplaced = unknownNames(readSettings(o.envFile).config).join(', ')
  const told = `${DIR}/config-unknown-told`
  if (unplaced && (existsSync(told) ? readFileSync(told, 'utf8') : '') !== unplaced) {
    void o.say(ownerLines.settingsUnplaced(unplaced))
      .then(sent => { if (sent) writeFileSync(told, unplaced) })
  }
  const SCOPES_TOLD = 'slack-scopes-told'
  void checkScopes(o.tokens).then(m => {
    const { send, told } = scopeDm(m, store.load(SCOPES_TOLD) as string | undefined)
    if (send) void o.say(send).then(sent => { if (sent) store.save(SCOPES_TOLD, told) })
    else store.save(SCOPES_TOLD, told)
  }).catch(e => log(`scope check failed: ${e}`))
}

export function replayMissed(store: Pick<Store, 'unhandled' | 'handled'>, replayOf: (connector: string) => ((source: string, payload: string) => Promise<unknown>) | undefined, now: number) {
  const missed = store.unhandled(now - 10 * 60_000)
  if (missed.length) log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} the last run heard but never handled`)
  for (const r of missed) {
    const replay = replayOf(r.connector)
    if (replay) void replay(r.source, r.payload).catch(e => log('replay failed', r.source, e))
    else { log('cannot replay', r.source, '(its connector is off)'); store.handled(r.source) }
  }
}
