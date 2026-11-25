import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import { log, logRef } from '../runtime/log.ts'
import { connectEmail } from '../connectors/email.ts'
import { connectGithub } from '../connectors/github.ts'
import { approvePolicy } from '../core/github-approve.ts'
import { connectMeeting } from '../connectors/meeting.ts'
import { connectVoice } from '../connectors/voice.ts'
import { connectSms } from '../connectors/sms.ts'
import { smsSender } from '../connectors/sms-send.ts'
import { openSmsStore } from '../runtime/sms-store.ts'
import { smsProvider } from '../core/sms.ts'
import { bridgeClock, startWhatsApp, wahaSeen, wahaUrl } from '../connectors/whatsapp.ts'
import type { connectSlack } from '../connectors/slack/connect.ts'
import { startJobEvents } from './job-events.ts'
import { meetCall } from '../core/meetbot.ts'
import type { Config, Secrets } from '../core/config.ts'
import type { Conversation, Lane } from '../core/conversations.ts'
import { startFailedNote, type Delivery, type Dispatcher } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from '../runtime/protocol.ts'
import type { Inbox, Store } from '../runtime/store.ts'
import { taskAsOwner } from '../core/gate.ts'
import { ownerLines } from '../core/messages.ts'

type Options = {
  secrets: Secrets; conn: NonNullable<Config['connectors']>; store: Store; slack: Awaited<ReturnType<typeof connectSlack>>; bot: WebClient
  ping: Parameters<typeof startJobEvents>[0]['ping']
  say: (text: string) => Promise<boolean>
  ownerAnswer: (a: { code: string; behavior: 'allow' | 'deny' }) => void
  NAME: string; CODE: string; DIR: string; d: Dispatcher<ToSession>; inbox: Inbox; emails: string[]
  deliver: (c: Conversation, task: Task, place: string, lane?: Lane, by?: string) => Delivery
  placeOf: (key: string) => string; failed: (m: ToSession) => void
  schedules: Parameters<typeof startJobEvents>[0]['schedules']; event: Parameters<typeof startJobEvents>[0]['event']; ledgers: Parameters<typeof startJobEvents>[0]['ledgers']; tripwires: Config['tripwires']
}

export function startConnectors(o: Options) {
  const { secrets, conn, store, slack, NAME, CODE, DIR, d, inbox, deliver, placeOf } = o
  const github = startGithub(o)
  const meeting = startMeeting(o)
  const email = connectEmail({
    mail: { ...conn.email, teammateEmails: o.emails, accessKeyId: secrets.aws?.accessKeyId, secretAccessKey: secrets.aws?.secretAccessKey }, saved: store, name: NAME, nameOf: slack.nameOf, deliver, inbox, dir: DIR,
    notify: text => void o.say(text),
    failed: task => void o.say(startFailedNote(task.meta.place, d.lastStartError())),
  })
  const voice = connectVoice({
    voice: { ...conn.voice, token: secrets.voiceToken }, name: NAME, deliver,
    end: key => { if (key.startsWith('voice:')) d.end(key) },
    slot: key => d.hasFreeSlot(key),
    failed: task => void o.say(startFailedNote(task.meta.place, d.lastStartError())),
  })
  const whatsapp = startWhatsapp(o)

  const url = wahaUrl(conn.whatsapp?.wahaUrl)
  const clock = bridgeClock({
    on: !!whatsapp, minutes: conn.whatsapp?.checkMinutes, look: () => wahaSeen(url, secrets.waha!.WAHA_API_KEY!), at: { url, qr: `${CODE}/waha/qr.sh` }, state: store, notify: slack.notifyOwner,
  })

  const sms = startSms(o)
  const jobs = startJobEvents({ store, inbox, ping: o.ping, notify: text => void o.say(text), schedules: o.schedules, event: o.event, ledgers: o.ledgers, tripwires: o.tripwires })

  const replies = {
    voice: (key: string, text: string) => { if (!meeting?.say(key, text)) voice?.reply(key, text) },
    wa: (key: string, text: string) => void whatsapp?.send(key, text).catch(e => log('whatsapp send failed in', logRef(key), e)),
    mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
      log('mail reply failed', logRef(key), e)
      void o.say(ownerLines.emailReplyFailed(placeOf(key), e))
    }),
    sms: (key: string, text: string) => void sms?.connector.reply(key, text),
  }
  function replayOf(connector: string): ((source: string, payload: string) => Promise<unknown>) | undefined {
    return ({ slack: slack.replay, github: github?.replay, meeting: meeting?.replay, whatsapp: whatsapp?.replay, sms: sms?.connector.replay, hook: jobs.replay } as Record<string, ((source: string, payload: string) => Promise<unknown>) | undefined>)[connector]
  }

  return { github, meeting, email, voice, whatsapp, sms, replies, replayOf, jobs, clock }
}

function startGithub(o: Options) {
  const { secrets, conn, store, slack, bot, d, inbox, deliver } = o
  const gh = conn.github, app = gh?.app, approve = approvePolicy(gh?.approve)
  const github = app && gh?.login && gh.userId && secrets.githubSecret && secrets.githubAppKey ? connectGithub({ startError: () => d.lastStartError(),
    saved: store, botDm: slack.ids.botDm, ownerId: gh.userId, accounts: gh.accounts?.length ? gh.accounts : [gh.login],
    app: { id: app.id, slug: app.slug, key: secrets.githubAppKey }, secret: secrets.githubSecret, port: gh.port || 8789,
    post: (text, thread) => bot.chat.postMessage({ channel: slack.ids.botDm, text, ...(thread && { thread_ts: thread }) }).then(r => r.ts, e => { log('github post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void o.say(text),
    perHour: gh.perHour || 20, inbox,
    ...(approve && { approve }),
  }) : undefined
  void github?.listening.then(port => log(`github listening: 127.0.0.1:${port}/github`), e => log('github could not listen', e))
  return github
}

function startMeeting(o: Options) {
  const { secrets, conn, store, slack, bot, NAME, CODE, d, inbox, deliver } = o
  const meeting = secrets.meetingToken ? connectMeeting({ startError: () => d.lastStartError(),
    token: secrets.meetingToken, port: conn.meeting?.port || 8790, botDm: slack.ids.botDm,
    post: text => bot.chat.postMessage({ channel: slack.ids.botDm, text }).then(r => r.ts, e => { log('meeting post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void o.say(text),
    perHour: conn.meeting?.perHour || 10, inbox, untake: source => store.untake(source), name: NAME,
    end: key => { if (meetCall(key)) d.end(key) },
  }) : undefined
  void meeting?.listening.then(port => { log(`meetings on: 127.0.0.1:${port}/meeting`); if (existsSync(`${CODE}/meetbot/node_modules`)) meetbot(o, port) }, e => log('meetings could not listen', e))
  return meeting
}

function meetbot(o: Options, port: number) {
  const { secrets, conn, CODE } = o
  const child: ChildProcess = spawn(process.execPath, ['bot.ts'], { cwd: `${CODE}/meetbot`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH'].flatMap(k => (process.env[k] ? [[k, process.env[k]]] : []))), KAGE_MEETBOT_HUB: `http://127.0.0.1:${port}`, KAGE_MEETBOT_TOKEN: secrets.meetingToken ?? "", KAGE_MEETBOT_PIPELINE: conn.meeting?.agentApi && conn.meeting.agentId ? JSON.stringify({ api: conn.meeting.agentApi, agent: conn.meeting.agentId }) : "", KAGE_MEETBOT_PIPELINE_KEY: secrets.voiceAgentKey ?? "" } })
  const lines = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) log(`meetbot: ${l.replace(/^\S+Z /, '')}`) }
  child.stdout?.on('data', lines)
  child.stderr?.on('data', lines)
  child.on('exit', (code: number | null) => { log(`meetbot exited (${code}), starting it again in 10 s`); setTimeout(() => meetbot(o, port), 10_000).unref() })
  process.once('exit', () => { child.kill() })
}

function startWhatsapp(o: Options) {
  const { secrets, conn, slack, DIR, NAME, inbox, deliver, failed } = o
  return conn.whatsapp?.on !== false && secrets.waha?.WAHA_API_KEY ? startWhatsApp({
    dir: DIR, name: NAME, owner: slack.ownerName, waha: secrets.waha, whatsapp: conn.whatsapp ?? {}, inbox,
    notify: text => void slack.notifyOwner(text),
    memory: conn.whatsapp?.memory || `${DIR}/wa-notes`, ownerAnswer: o.ownerAnswer,
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
}

function startSms(o: Options) {
  const { conn, secrets, bot, d, DIR } = o
  const c = conn.sms
  const provider = smsProvider(c)
  const creds = provider === 'twilio' ? c?.accountSid && secrets.twilioAuthToken : secrets.telnyxApiKey && c?.telnyxPublicKey
  if (!c || c.on === false || !c.from || !c.publicUrl || !creds) return undefined
  const keys = { accountSid: c.accountSid ?? undefined, twilioAuthToken: secrets.twilioAuthToken ?? undefined, telnyxApiKey: secrets.telnyxApiKey ?? undefined }
  const store = openSmsStore(`${DIR}/kage.db`)
  const connector = connectSms({
    provider, from: c.from, port: c.port || 8793, publicUrl: c.publicUrl, perHour: c.perHour || 30, perMinute: c.perMinute || 30,
    twilioAuthToken: keys.twilioAuthToken, telnyxPublicKey: c.telnyxPublicKey ?? undefined,
    send: smsSender({ provider, statusUrl: c.publicUrl, ...keys }),
    store, inbox: o.inbox, deliver: (conversation, task, place) => o.deliver(conversation, task, place),
    notify: text => void o.say(text),
    post: async (thread, text) => {
      const [channel, ts] = thread.split(':')
      if (!channel) return false
      return bot.chat.postMessage({ channel, text, ...(ts && /^\d+\.\d+$/.test(ts) && { thread_ts: ts }) })
        .then(r => r.ok === true, e => { log('sms report post failed', e); return false })
    },
    startError: () => d.lastStartError(),
  })
  void connector.listening.then(port => log(`sms on: 127.0.0.1:${port}/sms`), e => log('sms could not listen', e))
  return { connector, campaigns: store }
}
