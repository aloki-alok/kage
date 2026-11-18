import { jobHooks } from '../connectors/job-hooks.ts'
import type { Config } from '../core/config.ts'
import type { Schedule } from '../core/cron.ts'
import type { KageEvent } from '../core/events.ts'
import { jobEvents } from '../runtime/job-events.ts'
import { shadowSwaps } from '../runtime/shadow-swap.ts'
import { log } from '../runtime/log.ts'
import type { scheduler } from '../runtime/scheduler.ts'
import type { Inbox, Store } from '../runtime/store.ts'

export function startJobEvents(o: {
  store: Store; inbox: Inbox; notify: (text: string) => void
  ping: (key: string, text: string, job: string) => Promise<boolean>
  schedules: Pick<ReturnType<typeof scheduler>, 'add' | 'remove' | 'wake'>
  event: (e: Omit<KageEvent, 'at' | 'chain' | 'transcript'>) => void
  ledgers: Parameters<typeof shadowSwaps>[0]['ledgers']
  tripwires: Config['tripwires']
}) {
  const t = o.tripwires ?? {}
  const off = t.on === false
  const track = (who: string, detail: string) => o.event({ kind: 'tripwire', who, trace: '', detail })
  const ping = (key: string, text: string) => void o.ping(key, text, 'event').then(ok => ok || o.notify(text))
  const ev = jobEvents({ saved: o.store, schedules: () => o.store.schedules(), wake: o.schedules.wake, track, ping,
    cfg: () => ({ patternMax: t.patternMax || 200, maxPosts: t.maxPosts || 20, seenMax: t.seenMax || 500 }) })
  const swaps = shadowSwaps({ store: o.store, ledgers: o.ledgers, settings: () => t, owner: o.notify, ping, event: d => track('hub', d),
    remove: id => { const s = o.store.schedules().find(x => x.id === id); if (s) facade.remove(s.key, id) }, restore: s => facade.restore(s) })
  if (!off) { ev.rebuild(); o.store.save('job-off-told', undefined) }
  else {
    const paused = o.store.schedules().filter(s => s.trigger?.kind === 'channel' || s.trigger?.kind === 'hook')
    for (const s of paused) track(s.key, `paused job=${s.id} reason=off`)
    const set = paused.map(s => s.id).sort().join(',')
    if (paused.length && o.store.load('job-off-told') !== set) {
      o.notify(`${paused.length} event job${paused.length === 1 ? ' is' : 's are'} paused because tripwires are off. Run \`kage set tripwires.on true\` to turn ${paused.length === 1 ? 'it' : 'them'} back on.`)
      o.store.save('job-off-told', set)
    }
  }
  const hookOf = (id: string) => { const s = o.store.schedules().find(x => x.id === id); return s?.trigger?.kind === 'hook' ? { key: s.key, tokenHash: s.trigger.tokenHash } : undefined }
  const host = t.hookHost || '127.0.0.1'
  const hooks = t.hookPort && !off ? jobHooks({ host, port: t.hookPort, inbox: o.inbox, maxKb: () => t.maxKb || 64, perHour: () => t.hookPerHour || 60, hookOf,
    deliver: (job, quote, done) => ev.wake(job, [quote], done), track }) : undefined
  void hooks?.listening.then(port => log(`job webhooks on: ${host}:${port}/hook/<job id>`), e => log('job webhooks could not listen', e))
  const facade = {
    add(key: string, j: Parameters<typeof o.schedules.add>[1], now: number): string | undefined {
      const no = off && j.trigger ? 'tripwires are off: run `kage set tripwires.on true` first' : ev.refuse(j.trigger)
      if (no) return no
      const refused = o.schedules.add(key, j, now)
      if (!refused) ev.started(j.id, j.trigger)
      return refused
    },
    remove(key: string, id: string) {
      o.schedules.remove(key, id)
      if (!o.store.schedules().some(s => s.id === id)) ev.stopped(id)
    },
    restore(s: Schedule) { o.store.addSchedule(s); ev.started(s.id, s.trigger) },
    hookUrl: (id: string) => hooks && `http://${host}:${t.hookPort}/hook/${id}`,
    channelPost: (p: Parameters<typeof ev.channelPost>[0]) => { if (off) return; try { ev.channelPost(p) } catch (e) { log('channel post failed', e); track('hub', 'match failed=1') } },
    channelCatchUp: (h: Parameters<typeof ev.channelCatchUp>[0]) => { if (!off) void ev.channelCatchUp(h).catch(e => log('channel catch-up failed', e)) },
    channelGap: off ? () => {} : ev.channelGap,
    replay: hooks?.replay ?? (async (source: string, payload: string) => {
      o.inbox.handled(source)
      o.notify(`A webhook call for job ${(JSON.parse(payload) as { job: string }).job} could not run: job webhooks are off (tripwires.hookPort is 0, or tripwires.on is false). The call was dropped.`)
    }),
    close: () => hooks?.close(),
  }
  return { ...facade, swaps }
}
