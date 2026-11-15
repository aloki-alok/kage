// The hub's own code: the version it runs, the restart into newer code or changed settings, the auto-update that
// pulls origin's stable tag (core/auto-update.ts), and the release the owner's hub makes for every install (ADR 0013).
import { writeFileSync } from 'node:fs'
import { log } from '../runtime/log.ts'
import { codeStamp } from '../runtime/code-stamp.ts'
import { markUpdatedFrom, pullMain, version } from '../runtime/auto-update.ts'
import { releaseIfSoaked } from '../runtime/release.ts'
import { npmCi, packagesStale } from '../runtime/hub-log.ts'
import type { Ledgers } from '../runtime/ledger.ts'

export function hubUpdates(o: {
  code: string; dir: string; ledgers: Ledgers
  quiet: (now: number) => boolean   // every session is quiet and no usage-limit pause is on
  notify: (text: string) => unknown
}) {
  const BOOT_CODE = codeStamp(o.code)
  // The version of the code this hub runs, read once: kage status and kage doctor show it from this file.
  const VERSION = version(o.code)
  writeFileSync(`${o.dir}/version`, `${VERSION}\n`, { mode: 0o600 })
  // Each boot with its commit: the auto-release soak runs from the first boot on one commit (core/auto-update.ts soakRuns).
  o.ledgers.add('boots', [VERSION.split(' ')[0]!])
  let configRestart = false   // set by the settings watcher: restart once every session is quiet
  let npmFailedFor = 0   // the code stamp whose npm ci failed: not tried again until the code moves
  let lastSkip = ''

  return {
    VERSION,
    restartWanted(yes: boolean) { configRestart = yes },
    selfUpdate(now: number) {
      const code = codeStamp(o.code)
      const newCode = code && code !== BOOT_CODE && now - code > 10_000
      if (!(newCode || configRestart) || !o.quiet(now)) return
      // New code may need new packages: npm stamps node_modules/.package-lock.json on each install.
      if (newCode && packagesStale(o.code)) {
        if (npmFailedFor === code) return
        try { npmCi(o.code) } catch {
          npmFailedFor = code
          log('npm ci failed for the newer code, so the hub stays on the code it runs. Run npm ci in', o.code)
          void o.notify(`Kage pulled new code, but \`npm ci\` failed, so it stays on the code it runs. Run \`npm ci\` in ${o.code}, then \`kage restart\`.`)
          return
        }
      }
      log(newCode ? 'newer code is in place and every session is quiet: restarting into it' : 'settings changed and every session is quiet: restarting to apply them')
      process.exit(75)
    },
    // Moves a clean main checkout to origin's stable tag; selfUpdate then restarts into it.
    // ponytail: no signature check yet (#58), so a bad move of the stable tag reaches this install within 6 hours.
    async autoUpdate() {
      const r = await pullMain(o.code)
      if (r === 'pulled') { markUpdatedFrom(o.dir, VERSION); log('auto-update pulled the stable tag: the hub restarts into it once every session is quiet') }
      else if (r !== 'current') log(`auto-update did nothing: ${r.skip}`)
    },
    // A skip logs one line and DMs nothing. Hourly, because the job clock restarts with the hub: a daily period would never
    // fire on a hub that restarts daily. The line about the next candidate goes out every hour, so kage logs answers
    // "when is the next release?". Other skips repeat once.
    async autoRelease(now: number) {
      const r = await releaseIfSoaked(o.code, o.dir, o.ledgers.text('boots'), now).catch(e => ({ skip: `failed: ${e}`, broke: true, candidate: undefined }))
      if ('broke' in r) void o.notify(`Kage's release stopped part way: ${r.skip}.`)
      if ('skip' in r) { if (r.candidate || r.skip !== lastSkip) log(`auto-release did nothing: ${r.skip}`); lastSkip = r.skip; return }
      log(`auto-release made v${r.version}`)
      void o.notify(`Released Kage v${r.version}. <${r.url}|Release notes>`)
    },
  }
}
