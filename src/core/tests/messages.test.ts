import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ownerLines as L } from '../messages.ts'

const cases: [string, string][] = [
  [L.emailHeld(['a@x.test', 'b@x.test'], 'outside domain', 'hi\nthere'), 'Held an email reply to a@x.test, b@x.test (outside domain). Send it yourself if it is fine:\nhi\nthere'],
  [L.emailReplyFailed('#ops', new Error('boom')), 'Email reply failed for #ops: Error: boom'],
  [L.whatsappHeld('15550001', 'secret', 'msg'), 'Held a WhatsApp message to 15550001 (secret). Send it yourself if it is fine:\nmsg'],
  [L.githubOverCap(30, 'repo#1'), 'GitHub sent more than 30 events this hour, so I am skipping them until the hour is up. Latest: repo#1.'],
  [L.githubNoThread('repo#2', ''), 'A GitHub event for repo#2 could not open its thread here: no link'],
  [L.githubNoThread('repo#2', 'https://x.test/2'), 'A GitHub event for repo#2 could not open its thread here: https://x.test/2'],
  [L.githubFailed('x'.repeat(130)), `A GitHub event failed here (${'x'.repeat(120)}). It runs again if Kage restarts within 10 minutes; otherwise redeliver it from the app's Advanced page on GitHub.`],
  [L.meetingOverCap(5, 'Standup'), 'More than 5 meeting transcripts came in this hour, so I am skipping them. Send "Standup" again after the hour is up.'],
  [L.meetingNoThread('Standup'), 'Notes for the meeting "Standup" could not open a thread here. Send it again.'],
  [L.meetingFailed(new Error('bad')), 'A meeting transcript failed here (Error: bad). Send it again.'],
  [L.afkP0('Priya', '#ops', 'db down', undefined), ':rotating_light: P0 from Priya in #ops: db down\nCalling you now.'],
  [L.afkP0('Priya', '#ops', 'db down', 'no connectors.call.command'), ':rotating_light: P0 from Priya in #ops: db down\nCould not phone you (no connectors.call.command).'],
  [L.afkHeld('Priya', '#ops', 'looks like a key or secret', 'k=1'), 'Held a reply to Priya in #ops (looks like a key or secret). Post it yourself if it is fine:\nk=1'],
  [L.afkReplied('high', 'Priya', '#ops', 'asked', 'a\nb'), ':exclamation: Replied to Priya in #ops: asked\n> a\n> b'],
  [L.afkReplied('p0', 'P', 'w', 'n', 'r'), ':exclamation: Replied to P in w: n\n> r'],
  [L.afkReplied('low', 'P', 'w', 'n', 'r'), 'Replied to P in w: n\n> r'],
  [L.agentLoopStopped('ATEST1', '#dev', '20 turns a minute'), 'I stopped answering agent `ATEST1` in #dev: 20 turns a minute. Its posts are dropped while it is over the limit. A thread over the limit opens again when a person writes in it.'],
  [L.slackDown(), 'Slack has not reconnected for 6 minutes, so I may miss tags. I keep retrying. If it lasts, run `kage logs` on the Mac.'],
  [L.eventJobsPaused(1), '1 event job is paused because tripwires are off. Run `kage set tripwires.on true` to turn it back on.'],
  [L.eventJobsPaused(3), '3 event jobs are paused because tripwires are off. Run `kage set tripwires.on true` to turn them back on.'],
  [L.jobHookOff('deploy-watch'), 'A webhook call for job deploy-watch could not run: job webhooks are off (tripwires.hookPort is 0, or tripwires.on is false). The call was dropped.'],
  [L.holdsLifted('ops', 2), 'Lifted 2 deny holds on ops. It may ask about those steps again.'],
  [L.holdsLifted('ops', 1), 'Lifted 1 deny hold on ops. It may ask about those steps again.'],
  [L.holdsLifted('ops', 0), 'ops has no deny holds.'],
  [L.cronImportBad(), 'Could not read the cron jobs exported from the panes (crons-import.json.bad). Watchers may need setting up again.'],
  [L.settingsUnplaced('FOO, BAR'), 'Kage moved its settings into config.json. It could not place these old lines, so they sit under "unknown": FOO, BAR. Tell me what each one is for, and I will help place it.'],
  [L.peopleTidied('config.json.before-tidy-1', []), 'Kage rewrote config.json in its new shape: teammates, trusted people and teammate emails now sit in one list under people.teammates. Nothing about who may tag Kage changed. The old file is kept for 7 days as config.json.before-tidy-1.'],
  [L.peopleTidied('b', [{ email: 'a@x.test', user: 'UTEST1' }, { email: 'c@x.test', user: 'UTEST2' }]), 'Kage rewrote config.json in its new shape: teammates, trusted people and teammate emails now sit in one list under people.teammates. Nothing about who may tag Kage changed. The old file is kept for 7 days as b.\nMatched by email in Slack: a@x.test is <@UTEST1>, c@x.test is <@UTEST2>.'],
  [L.settingsRejected('people.trusted: bad id'), 'Kage did not apply your last settings change and keeps the last good ones: people.trusted: bad id'],
  [L.updateNpmFailed('/opt/kage'), 'Kage pulled new code, but `npm ci` failed, so it stays on the code it runs. Run `npm ci` in /opt/kage, then `kage restart`.'],
  [L.releaseStopped('tag exists'), "Kage's release stopped part way: tag exists."],
  [L.released('0.4.4', 'https://x.test/r'), 'Released Kage v0.4.4. <https://x.test/r|Release notes>'],
  [L.limitLost(['#a']), 'After the usage limit, 1 held message could not be resumed: #a. Ask again in its thread.'],
  [L.limitLost(['#a', '#b']), 'After the usage limit, 2 held messages could not be resumed: #a, #b. Ask again in their threads.'],
  [L.smsOverCap(30), 'More than 30 texts came in this hour, so I am storing them without answering until the hour is up. Each one counts in its campaign report.'],
  [L.smsAuthFailed('20003'), "The SMS provider refused Kage's credentials (code 20003), so I paused the campaigns that were sending. Fix the keys in secrets.json, then resume each campaign."],
  [L.smsReportUnposted(3, 'promo: done'), 'A campaign report did not post in its thread after 3 tries, so I marked the campaign done and put the report here:\npromo: done'],
  [L.smsReplyFailed('SMS contact 7', '21610'), 'A text reply to SMS contact 7 did not go out: the SMS provider said 21610.'],
]

test('each owner line reads exactly as the line it replaced', () => {
  for (const [got, want] of cases) assert.equal(got, want)
})

test('every owner line has a case above', () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.deepEqual(Object.keys(L).filter(k => !src.includes(`L.${k}(`)), [])
})
