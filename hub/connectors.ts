// The connectors the hub starts beside Slack, each on when its secret or config is there: GitHub, meetings (and the
// meeting bot as the hub's child), email, voice and WhatsApp. Also how a session's reply reaches each one, and how a
// stored message replays through its own connector after a restart.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import { log, logRef } from '../runtime/log.ts'
import { connectEmail } from '../connectors/email.ts'
import { connectGithub } from '../connectors/github.ts'
import { connectMeeting } from '../connectors/meeting.ts'
import { connectVoice } from '../connectors/voice.ts'
import { startWhatsApp } from '../connectors/whatsapp.ts'
import type { connectSlack } from '../connectors/slack.ts'
import { meetCall } from '../core/meetbot.ts'
import type { Config, Secrets } from '../core/config.ts'
import type { Conversation, Lane } from '../core/conversations.ts'
import type { Delivery, Dispatcher } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from '../runtime/protocol.ts'
import type { Inbox, Store } from '../runtime/store.ts'

export function startConnectors(o: {
  secrets: Secrets; conn: NonNullable<Config['connectors']>; store: Store; slack: Awaited<ReturnType<typeof connectSlack>>; bot: WebClient
  NAME: string; CODE: string; DIR: string; d: Dispatcher<ToSession>; inbox: Inbox
  deliver: (c: Conversation, task: Task, place: string, lane?: Lane, by?: string) => Delivery
  placeOf: (key: string) => string; failed: (m: ToSession) => void
}) {
  const { secrets, conn, store, slack, bot, NAME, CODE, DIR, d, inbox, deliver, placeOf, failed } = o
  // GitHub is on when githubSecret and connectors.github.login are set: a webhook through a tunnel.
  const github = secrets.githubSecret && conn.github?.login ? connectGithub({
    saved: store, secret: secrets.githubSecret, login: conn.github.login, port: conn.github.port || 8789, botDm: slack.ids.botDm,
    post: (text, thread) => bot.chat.postMessage({ channel: slack.ids.botDm, text, ...(thread && { thread_ts: thread }) }).then(r => r.ts, e => { log('github post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void slack.notifyOwner(text),
    perHour: conn.github.perHour || 20, inbox,
  }) : undefined
  void github?.listening.then(port => log(`github on: 127.0.0.1:${port}/github for @${conn.github?.login}`))
  // Meetings are on when meetingToken is set: a finished transcript gets notes in its own DM thread.
  const meeting = secrets.meetingToken ? connectMeeting({
    token: secrets.meetingToken, port: conn.meeting?.port || 8790, botDm: slack.ids.botDm,
    post: text => bot.chat.postMessage({ channel: slack.ids.botDm, text }).then(r => r.ts, e => { log('meeting post failed', e); return undefined }),
    deliver: (c, task, place) => deliver(c, task, place),
    notify: text => void slack.notifyOwner(text),
    perHour: conn.meeting?.perHour || 10, inbox, untake: source => store.untake(source), name: NAME,
    end: key => { if (meetCall(key)) d.end(key) },   // only the call's own session
  }) : undefined
  void meeting?.listening.then(port => { log(`meetings on: 127.0.0.1:${port}/meeting`); if (existsSync(`${CODE}/meetbot/node_modules`)) meetbot(port) })
  // The meeting bot runs as the hub's child when it is installed in this checkout (meetbot/node_modules): it waits
  // for a join and opens a headless browser only for a call, with only what a browser needs (never the hub's tokens). It restarts after a crash and ends with the hub.
  // A bot on another machine still works the same way, from its own config (meetbot/README.md).
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
    mail: { ...conn.email, accessKeyId: secrets.aws?.accessKeyId, secretAccessKey: secrets.aws?.secretAccessKey }, saved: store, name: NAME, deliver, inbox,
    failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
  })
  // Voice is on when voiceToken is set, unless connectors.voice.on is false. A voice agent reaches it over a tunnel.
  const voice = connectVoice({
    voice: { ...conn.voice, token: secrets.voiceToken }, name: NAME, deliver,
    end: key => { if (key.startsWith('voice:')) d.end(key) },   // only the call's own session
    slot: key => d.hasFreeSlot(key),   // a call never evicts or queues ahead of the owner's threads
    failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
  })
  // WhatsApp is on when Kage's WAHA config exists, unless connectors.whatsapp.on is false (the kill switch).
  const whatsapp = conn.whatsapp?.on !== false && existsSync(`${DIR}/waha/.env`) ? startWhatsApp({
    dir: DIR, name: NAME, owner: slack.ownerName, whatsapp: conn.whatsapp ?? {}, inbox,
    notify: text => void slack.notifyOwner(text),
    // The stand-in reads only this folder: notes the owner wrote for it, never their whole memory.
    memory: conn.whatsapp?.memory || `${DIR}/wa-notes`,
    onTask(t) {
      const task: Task = {
        type: 'task', content: t.content, fromOwner: true,
        meta: { channel: 'whatsapp', thread_ts: t.chat, place: t.place, permalink: '' },
        origin: { channel: 'whatsapp', ts: t.chat },
      }
      log('whatsapp task in', logRef(t.chat))
      if (deliver({ connector: 'whatsapp', chat: t.chat, kind: 'chat' }, task, t.place) === 'failed') failed(task)
    },
  }) : undefined

  const replies = {
    voice: (key: string, text: string) => { if (!meeting?.say(key, text)) voice?.reply(key, text) },   // voice:meet-<call> is a Meet call (#63)
    wa: (key: string, text: string) => void whatsapp?.send(key, text).catch(e => log('whatsapp send failed in', logRef(key), e)),
    mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
      log('mail reply failed', logRef(key), e)
      void slack.notifyOwner(`Email reply failed for ${placeOf(key)}: ${e}`)
    }),
  }
  // How a stored message runs again: through its own connector, as if just heard.
  function replayOf(connector: string): ((source: string, payload: string) => Promise<unknown>) | undefined {
    return ({ slack: slack.replay, github: github?.replay, meeting: meeting?.replay, whatsapp: whatsapp?.replay } as Record<string, ((source: string, payload: string) => Promise<unknown>) | undefined>)[connector]
  }

  return { github, meeting, email, voice, whatsapp, replies, replayOf }
}
