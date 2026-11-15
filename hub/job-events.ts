// Jobs that an event wakes, in the hub: Slack channel posts and job webhooks (ADR 0015). Builds the pieces from
// settings, rebuilds every channel watch from the stored triggers at start, and hands the router one place to call.
import type { WebClient } from '@slack/web-api'
import { jobHooks } from '../connectors/job-hooks.ts'
import type { Config } from '../core/config.ts'
import type { KageEvent } from '../core/events.ts'
import { jobEvents } from '../runtime/job-events.ts'
import { log } from '../runtime/log.ts'
import type { scheduler } from '../runtime/scheduler.ts'
import type { Inbox, Store } from '../runtime/store.ts'

export function startJobEvents(o: {
  store: Store; inbox: Inbox; bot: WebClient; notify: (text: string) => void
  schedules: Pick<ReturnType<typeof scheduler>, 'add' | 'remove' | 'wake'>
  event: (e: Omit<KageEvent, 'at' | 'chain' | 'transcript'>) => void
  tripwires: Config['tripwires']
}) {
  const t = o.tripwires ?? {}
  const off = t.on === false
  const track = (who: string, detail: string) => o.event({ kind: 'tripwire', who, trace: '', detail })
  // As Kage in the job's thread, with no model. Where the bot cannot post, the owner hears it instead.
  const ping = (key: string, text: string) => {
    const c = o.store.conversation(key)?.conversation
    if (!c) return
    o.bot.chat.postMessage({ channel: c.chat, text, ...(c.thread && { thread_ts: c.thread }) }).catch(e => { log('could not post a tripwire ping', e?.data?.error ?? e); o.notify(text) })
  }
  const ev = jobEvents({ saved: o.store, schedules: () => o.store.schedules(), wake: o.schedules.wake, track, ping,
    cfg: () => ({ patternMax: t.patternMax || 200, maxPosts: t.maxPosts || 20, seenMax: t.seenMax || 500 }) })
  if (!off) { ev.rebuild(); o.store.save('job-off-told', undefined) }
  else {
    // Off stops stored event jobs without a word, so say it: one DM per set of paused jobs, and a row for each.
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
  void hooks?.listening.then(port => log(`job webhooks on: ${host}:${port}/hook/<job id>`))
  return {
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
    hookUrl: (id: string) => hooks && `http://${host}:${t.hookPort}/hook/${id}`,
    channelPost: (p: Parameters<typeof ev.channelPost>[0]) => { if (off) return; try { ev.channelPost(p) } catch (e) { log('channel post failed', e); track('hub', 'match failed=1') } },
    channelCatchUp: (h: Parameters<typeof ev.channelCatchUp>[0]) => { if (!off) void ev.channelCatchUp(h).catch(e => log('channel catch-up failed', e)) },
    channelGap: off ? () => {} : ev.channelGap,
    // With no webhook server the stored call cannot run, so the owner hears it, and it leaves the inbox.
    replay: hooks?.replay ?? (async (source: string, payload: string) => {
      o.inbox.handled(source)
      o.notify(`A webhook call for job ${(JSON.parse(payload) as { job: string }).job} could not run: job webhooks are off (tripwires.hookPort is 0, or tripwires.on is false). The call was dropped.`)
    }),
    close: () => hooks?.close(),
  }
}
