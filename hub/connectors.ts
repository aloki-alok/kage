import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import { log, logRef } from '../runtime/log.ts'
import { connectEmail } from '../connectors/email.ts'
import { connectGithub } from '../connectors/github.ts'
import { connectMeeting } from '../connectors/meeting.ts'
import { connectVoice } from '../connectors/voice.ts'
import { bridgeClock, startWhatsApp, wahaSeen, wahaUrl } from '../connectors/whatsapp.ts'
import type { connectSlack } from '../connectors/slack.ts'
import { startJobEvents } from './job-events.ts'
import { meetCall } from '../core/meetbot.ts'
import type { Config, Secrets } from '../core/config.ts'
import type { Conversation, Lane } from '../core/conversations.ts'
import type { Delivery, Dispatcher } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from '../runtime/protocol.ts'
import type { Inbox, Store } from '../runtime/store.ts'
import { taskAsOwner } from '../core/gate.ts'

export function startConnectors(o: {
  secrets: Secrets; conn: NonNullable<Config['connectors']>; store: Store; slack: Awaited<ReturnType<typeof connectSlack>>; bot: WebClient
  ping: Parameters<typeof startJobEvents>[0]['ping']
  say: (text: string) => Promise<boolean>
  NAME: string; CODE: string; DIR: string; d: Dispatcher<ToSession>; inbox: Inbox
  deliver: (c: Conversation, task: Task, place: string, lane?: Lane, by?: string) => Delivery
  placeOf: (key: string) => string; failed: (m: ToSession) => void
  schedules: Parameters<typeof startJobEvents>[0]['schedules']; event: Parameters<typeof startJobEvents>[0]['event']; ledgers: Parameters<typeof startJobEvents>[0]['ledgers']; tripwires: Config['tripwires']
}) {
  const { secrets, conn, store, slack, bot, NAME, CODE, DIR, d, inbox, deliver, placeOf, failed } = o
  const github = secrets.githubSecret && conn.github?.login ? connectGithub({
    saved: store, secret: secrets.githubSecret, login: conn.github.login, port: conn.github.port || 8789, botDm: slack.ids.botDm,
    post: (text, thread) => bot.chat.postMessage({ channel: slack.ids.botDm, text, ...(thread && { thread_ts: thread }) }).then(r => r.ts, e => { log('github post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void o.say(text),
    perHour: conn.github.perHour || 20, inbox,
  }) : undefined
  void github?.listening.then(port => log(`github on: 127.0.0.1:${port}/github for @${conn.github?.login}`), e => log('github could not listen', e))
  const meeting = secrets.meetingToken ? connectMeeting({
    token: secrets.meetingToken, port: conn.meeting?.port || 8790, botDm: slack.ids.botDm,
    post: text => bot.chat.postMessage({ channel: slack.ids.botDm, text }).then(r => r.ts, e => { log('meeting post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void o.say(text),
    perHour: conn.meeting?.perHour || 10, inbox, untake: source => store.untake(source), name: NAME,
    end: key => { if (meetCall(key)) d.end(key) },
  }) : undefined
  void meeting?.listening.then(port => { log(`meetings on: 127.0.0.1:${port}/meeting`); if (existsSync(`${CODE}/meetbot/node_modules`)) meetbot(port) }, e => log('meetings could not listen', e))
  function meetbot(port: number) {
    const child: ChildProcess = spawn(process.execPath, ['bot.ts'], { cwd: `${CODE}/meetbot`, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH'].flatMap(k => (process.env[k] ? [[k, process.env[k]]] : []))), KAGE_MEETBOT_HUB: `http://127.0.0.1:${port}`, KAGE_MEETBOT_TOKEN: secrets.meetingToken ?? "", KAGE_MEETBOT_PIPELINE: conn.meeting?.agentApi && conn.meeting.agentId ? JSON.stringify({ api: conn.meeting.agentApi, agent: conn.meeting.agentId }) : "", KAGE_MEETBOT_PIPELINE_KEY: secrets.voiceAgentKey ?? "" } })
    const lines = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) log(`meetbot: ${l.replace(/^\S+Z /, '')}`) }
    child.stdout?.on('data', lines)
    child.stderr?.on('data', lines)
    child.on('exit', (code: number | null) => { log(`meetbot exited (${code}), starting it again in 10 s`); setTimeout(() => meetbot(port), 10_000).unref() })
    process.once('exit', () => { child.kill() })
  }
  const email = connectEmail({
    mail: { ...conn.email, accessKeyId: secrets.aws?.accessKeyId, secretAccessKey: secrets.aws?.secretAccessKey }, saved: store, name: NAME, nameOf: slack.nameOf, deliver, inbox, dir: DIR,
    notify: text => void o.say(text),
    failed: task => void o.say(`Could not start a session for ${task.meta.place}.`),
  })
  const voice = connectVoice({
    voice: { ...conn.voice, token: secrets.voiceToken }, name: NAME, deliver,
    end: key => { if (key.startsWith('voice:')) d.end(key) },
    slot: key => d.hasFreeSlot(key),
    failed: task => void o.say(`Could not start a session for ${task.meta.place}.`),
  })
  const whatsapp = conn.whatsapp?.on !== false && secrets.waha?.WAHA_API_KEY ? startWhatsApp({
    dir: DIR, name: NAME, owner: slack.ownerName, waha: secrets.waha, whatsapp: conn.whatsapp ?? {}, inbox,
    notify: text => void slack.notifyOwner(text),
    memory: conn.whatsapp?.memory || `${DIR}/wa-notes`,
    onTask(t) {
      const task = taskAsOwner({
        content: t.content,
        meta: { channel: 'whatsapp', thread_ts: t.chat, place: t.place, permalink: '' },
        origin: { channel: 'whatsapp', ts: t.chat }, ...(t.source && { source: t.source }),
      })
      log('whatsapp task in', logRef(t.chat))
      if (deliver({ connector: 'whatsapp', chat: t.chat, kind: 'chat' }, task, t.place) === 'failed') failed(task)
    },
  }) : undefined

  const url = wahaUrl(conn.whatsapp?.wahaUrl)
  const clock = bridgeClock({
    on: !!whatsapp, minutes: conn.whatsapp?.checkMinutes, look: () => wahaSeen(url, secrets.waha!.WAHA_API_KEY!), at: { url, qr: `${CODE}/waha/qr.sh` }, state: store, notify: slack.notifyOwner,
  })

  const jobs = startJobEvents({ store, inbox, ping: o.ping, notify: text => void o.say(text), schedules: o.schedules, event: o.event, ledgers: o.ledgers, tripwires: o.tripwires })

  const replies = {
    voice: (key: string, text: string) => { if (!meeting?.say(key, text)) voice?.reply(key, text) },
    wa: (key: string, text: string) => void whatsapp?.send(key, text).catch(e => log('whatsapp send failed in', logRef(key), e)),
    mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
      log('mail reply failed', logRef(key), e)
      void o.say(`Email reply failed for ${placeOf(key)}: ${e}`)
    }),
  }
  function replayOf(connector: string): ((source: string, payload: string) => Promise<unknown>) | undefined {
    return ({ slack: slack.replay, github: github?.replay, meeting: meeting?.replay, whatsapp: whatsapp?.replay, hook: jobs.replay } as Record<string, ((source: string, payload: string) => Promise<unknown>) | undefined>)[connector]
  }

  return { github, meeting, email, voice, whatsapp, replies, replayOf, jobs, clock }
}
