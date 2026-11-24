import { readFileSync, writeFileSync } from 'node:fs'
import { log } from '../runtime/log.ts'
import { codeStamp } from '../runtime/code-stamp.ts'
import { markUpdatedFrom, pullMain, version } from '../runtime/auto-update.ts'
import { releaseIfSoaked } from '../runtime/release.ts'
import type { ErrorSeen } from '../core/auto-update.ts'
import { noteExit, npmCi, packagesStale } from '../runtime/hub-log.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import { ownerLines } from '../core/messages.ts'

export function hubUpdates(o: {
  code: string; dir: string; ledgers: Ledgers
  quiet: (now: number) => boolean
  notify: (text: string) => Promise<boolean>
}) {
  const BOOT_CODE = codeStamp(o.code)
  const VERSION = version(o.code)
  writeFileSync(`${o.dir}/version`, `${VERSION}\n`, { mode: 0o600 })
  o.ledgers.add('boots', [VERSION.split(' ')[0]!])
  let configRestart = false
  let npmFailedFor = 0
  let lastSkip = ''

  return {
    VERSION,
    restartWanted(yes: boolean) { configRestart = yes },
    selfUpdate(now: number) {
      const code = codeStamp(o.code)
      const newCode = code && code !== BOOT_CODE && now - code > 10_000
      if (!(newCode || configRestart) || !o.quiet(now)) return
      if (newCode && packagesStale(o.code)) {
        if (npmFailedFor === code) return
        try { npmCi(o.code) } catch {
          npmFailedFor = code
          log('npm ci failed for the newer code, so the hub stays on the code it runs. Run npm ci in', o.code)
          void o.notify(ownerLines.updateNpmFailed(o.code))
          return
        }
      }
      log(newCode ? 'newer code is in place and every session is quiet: restarting into it' : 'settings changed and every session is quiet: restarting to apply them')
      noteExit(o.dir, newCode ? 'update' : 'settings')
      process.exit(75)
    },
    async autoUpdate() {
      const r = await pullMain(o.code)
      if (r === 'pulled') { markUpdatedFrom(o.dir, VERSION); log('auto-update pulled the stable tag: the hub restarts into it once every session is quiet') }
      else if (r !== 'current') log(`auto-update did nothing: ${r.skip}`)
    },
    async autoRelease(now: number) {
      const r = await releaseIfSoaked(o.code, o.dir, o.ledgers.text('boots'), now, errorsSeen(o.ledgers, now)).catch(e => ({ skip: `failed: ${e}`, broke: true, candidate: undefined }))
      if ('broke' in r) void o.notify(ownerLines.releaseStopped(r.skip))
      if ('held' in r && r.held) await tellHeldOnce(o, r.held.sha, r.skip)
      if ('skip' in r) { if (r.candidate || r.skip !== lastSkip) log(`auto-release did nothing: ${r.skip}`); lastSkip = r.skip; return }
      log(`auto-release made v${r.version}`)
      void o.notify(ownerLines.released(r.version, r.url))
    },
  }
}

const RELEASE_HELD = 'release-held'

function errorsSeen(ledgers: Ledgers, now: number): ErrorSeen[] {
  const days = Array.from({ length: 31 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10))
  return days.flatMap(day => ledgers.events(day)).filter(e => e.kind === 'error').map(e => ({ at: Date.parse(e.at), code: e.detail }))
}

export async function tellHeldOnce(o: { dir: string; notify: (text: string) => Promise<boolean> }, sha: string, why: string) {
  const told = `${sha} ${why}`
  try { if (readFileSync(`${o.dir}/${RELEASE_HELD}`, 'utf8') === told) return } catch {}
  if (await o.notify(ownerLines.releaseHeld(sha, why))) writeFileSync(`${o.dir}/${RELEASE_HELD}`, told, { mode: 0o600 })
}
