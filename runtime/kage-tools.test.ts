import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveCronJobs } from '../core/cron.ts'
import { openLedgers } from './ledger.ts'
import { sessionTools } from './kage-tools.ts'
import type { Task } from './protocol.ts'

// A fake Slack: records posts, edits, deletes and reactions; the bot is not in channel "CPRIV".
function fakeSlack() {
  const calls: string[] = []
  const posts: { channel: string; thread_ts?: string; text: string }[] = []
  let n = 0
  const client = (who: string) => ({
    chat: {
      postMessage: async (a: { channel: string; thread_ts?: string; text: string }) => {
        if (who === 'bot' && a.channel === 'CPRIV') throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })
        posts.push({ channel: a.channel, thread_ts: a.thread_ts, text: a.text })
        calls.push(`${who} post ${a.channel} ${a.text}`)
        return { ts: `9.${++n}` }
      },
      update: async (a: { channel: string; ts: string; text: string }) => { calls.push(`${who} edit ${a.channel} ${a.ts} ${a.text}`) },
      delete: async (a: { channel: string; ts: string }) => { calls.push(`${who} delete ${a.channel} ${a.ts}`) },
      getPermalink: async (a: { channel: string; message_ts: string }) => ({ permalink: `https://x/${a.channel}/${a.message_ts}` }),
    },
    conversations: {
      open: async (a: { users: string }) => {
        if (a.users.includes('UNOSCOPE')) throw Object.assign(new Error('x'), { data: { error: 'missing_scope' } })
        calls.push(`${who} open ${a.users}`)
        return { channel: { id: `G-${a.users}` } }
      },
    },
    filesUploadV2: async (a: { channel_id: string; thread_ts: string; filename: string }) => {
      if (a.channel_id === 'CPRIV') throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })
      calls.push(`${who} file ${a.channel_id} ${a.thread_ts} ${a.filename}`)
      return {}
    },
    reactions: { add: async (a: { channel: string; name: string }) => { calls.push(`${who} react ${a.channel} ${a.name}`) } },
    users: { info: async () => ({ user: { real_name: 'Sam' } }) },
  })
  return { calls, posts, bot: client('bot'), user: client('owner') }
}

function setup(o: { hubDown?: boolean; dir?: string } = {}) {
  const slack = fakeSlack()
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'kage-tools-'))
  const ledgers = openLedgers(dir)
  const out: string[] = []
  const jobs: any[] = []
  const t = sessionTools({
    title: 'Kage', bot: slack.bot as any, user: slack.user as any, botDm: () => 'DBOT', dir, ledgers, send: m => { if (o.hubDown) return false; out.push(`${m.type} ${m.text}`) }, memory: { own: '/own', owner: '/owner' },
    schedules: {
      add: j => { jobs.push({ ...j, key: 'C1:5.5', created: 0, lastFired: 0 }) },
      remove: id => { jobs.splice(jobs.findIndex(j => j.id === id), 1) },
      list: () => jobs,
    },
    afk: async c => { out.push(`afk ${JSON.stringify(c)}`); return 'AFK on' },
  })
  const call = (name: string, args: Record<string, unknown>) => t.tools.find(x => x.name === name)!.run(args)
  const task = (o: Partial<Task['meta']> & { fromOwner?: boolean } = {}): Task => ({
    type: 'task', content: 'Task from Sam: hi', fromOwner: o.fromOwner ?? true,
    meta: { channel: o.channel ?? 'C1', thread_ts: o.thread_ts ?? '5.5', place: '#general', permalink: 'https://x/p' },
    origin: { channel: o.channel ?? 'C1', ts: '5.5' },
  })
  return { ...slack, dir, ledgers, out, t, call, task, jobs }
}

describe("a session's Kage tools", () => {
  test('a reply goes only where a task came from; elsewhere it is refused', async () => {
    const s = setup()
    s.t.onTask(s.task())
    const ok = await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'done' })
    assert.equal(ok.isError, undefined)
    assert.match(ok.text, /channel C1, ts 9\.1/)
    const no = await s.call('reply', { channel: 'COTHER', thread_ts: '1.1', text: 'hi' })
    assert.equal(no.isError, true)
    assert.ok(s.calls.includes('bot post C1 done'))
    assert.ok(!s.calls.some(c => c.includes('COTHER')))
  })
  test('the first reply marks the task answered; where the bot is not a member it posts as the owner, marked', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'CPRIV' }))
    await s.call('reply', { channel: 'CPRIV', thread_ts: '5.5', text: 'done' })
    assert.ok(s.calls.includes('owner post CPRIV *Kage:* done'))
    assert.ok(s.calls.includes('owner react CPRIV crossed_swords'))
  })
  test('the reaction says what the reply was: an ack marks nothing, a question waits, a quick answer and a finished task differ', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'On it', mark: 'ack' })
    assert.ok(!s.calls.some(c => c.includes('react')))
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'Which org?', mark: 'question' })
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'done', mark: 'done' })
    assert.deepEqual(s.calls.filter(c => c.includes('react')), ['owner react C1 scroll', 'owner react C1 crossed_swords'])
    s.t.onTask(s.task({ channel: 'C2' }))
    await s.call('reply', { channel: 'C2', thread_ts: '5.5', text: '42', mark: 'answer' })
    assert.ok(s.calls.includes('owner react C2 dagger_knife'))
  })
  test('when the owner answers a question with a new tag, the finished task marks both messages', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'Which org?', mark: 'question' })
    s.t.onTask({ ...s.task(), origin: { channel: 'C1', ts: '6.6' } })
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'done', mark: 'done' })
    assert.deepEqual(s.calls.filter(c => c.includes('crossed_swords')).length, 2)
  })
  test('a schedule is checked, kept by the hub with the trust of the task that asked, listed and cancelled', async () => {
    const s = setup()
    s.t.onTask(s.task({ fromOwner: false }))
    assert.equal((await s.call('schedule', { cron: '61 * * * *', prompt: 'x' })).isError, true)
    const r = await s.call('schedule', { cron: '*/15 * * * *', prompt: 'check the queue' })
    assert.match(r.text, /^Kage schedule [0-9a-f]{8} set, recurring/)
    // The pane runner reads "Scheduled ... job" as Claude's own CronCreate, which would keep the session as watching.
    assert.deepEqual(liveCronJobs([{ timestamp: new Date().toISOString(), text: r.text }], 0, Date.now()), [])
    assert.deepEqual(s.jobs.map(j => [j.cron, j.prompt, j.recurring]), [['*/15 * * * *', 'check the queue', true]])
    assert.match((await s.call('schedules', {})).text, /check the queue/)
    assert.equal((await s.call('unschedule', { id: 'ffffffff' })).isError, true)    // not this thread's
    assert.equal((await s.call('unschedule', { id: s.jobs[0].id })).isError, undefined)
    assert.deepEqual(s.jobs, [])
  })
  test("only the owner's task pings; a teammate's mention shows the name", async () => {
    const s = setup()
    s.t.onTask(s.task({ fromOwner: false }))
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'ask <@U1>' })
    s.t.onTask(s.task({ channel: 'C2' }))
    await s.call('reply', { channel: 'C2', thread_ts: '5.5', text: 'ask <@U1>' })
    assert.ok(s.calls.includes('bot post C1 ask @Sam'))
    assert.ok(s.calls.includes('bot post C2 ask <@U1>'))
  })
  test('a secret never goes to a thread on a teammate task', async () => {
    const s = setup()
    s.t.onTask(s.task({ fromOwner: false }))
    const r = await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'key AKIAABCDEFGHIJKLMNOP', owner_asked: true })
    assert.equal(r.isError, true)
    assert.ok(!s.calls.some(c => c.includes('post')))
  })
  test('a table too wide for the thread panel is sent back to be narrowed, on a reply and on an edit; a log may opt out', async () => {
    const s = setup()
    s.t.onTask(s.task())
    const row = `\`\`\`\n+15550100248  Riverside Learning Academy Orga  never        2026-11-30\n\`\`\``
    const no = await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: row })
    assert.equal(no.isError, true)
    assert.match(no.text, /wider than 60/)
    assert.ok(!s.calls.some(c => c.includes('post')))
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'v1' })
    assert.equal((await s.call('edit_message', { channel: 'C1', ts: '9.1', text: row })).isError, true)
    assert.equal((await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: row, wide: true })).isError, undefined)
  })
  test('a file goes to the thread a task came from, only as a CSV or a PNG, never with a secret in it', async () => {
    const s = setup()
    s.t.onTask(s.task({ fromOwner: false }))
    const out = join(s.dir, 'files', 'C1_5.5')   // this thread's own folder
    const csv = join(out, 'idle-numbers.csv')
    writeFileSync(csv, 'phone,account\n+15550100248,Riverside Learning\n')
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: csv })).isError, undefined)
    assert.ok(s.calls.includes('bot file C1 5.5 idle-numbers.csv'))
    assert.equal((await s.call('send_file', { channel: 'COTHER', thread_ts: '1.1', path: csv })).isError, true)
    const env = join(out, 'env')
    writeFileSync(env, 'SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghij\n')
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: env })).isError, true)
    const leak = join(out, 'keys.csv')
    writeFileSync(leak, 'name,key\nbot,xoxb-1234567890-abcdefghij\n')
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: leak })).isError, true)
    const passwords = join(out, 'users.csv')
    writeFileSync(passwords, 'user,Password\nbob,Hunter2Hunter2X9\n')
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: passwords })).isError, true)
    // Only files written into Kage's files folder go out: not a sheet elsewhere on disk, not a link out of the folder.
    const elsewhere = join(s.dir, 'customers.csv')
    writeFileSync(elsewhere, 'a,b\n1,2\n')
    assert.match((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: elsewhere })).text, /files folder/)
    symlinkSync(elsewhere, join(out, 'link.csv'))
    assert.match((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: join(out, 'link.csv') })).text, /files folder/)
    // The type is the real file's: a .png link to a CSV is checked as that CSV.
    symlinkSync(leak, join(out, 'chart.png'))
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: join(out, 'chart.png') })).isError, true)
    // Another thread's folder is not this thread's to send, even in a session that has both.
    s.t.onTask(s.task({ channel: 'C2' }))
    const other = join(s.dir, 'files', 'C2_5.5', 'owner-only.csv')
    writeFileSync(other, 'a,b\n1,2\n')
    assert.equal((await s.call('send_file', { channel: 'C1', thread_ts: '5.5', path: other })).isError, true)
    assert.equal(s.calls.filter(c => c.includes(' file ')).length, 1)
  })
  test('where the bot cannot attach a file, the session is told to post the table instead', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'CPRIV' }))
    const csv = join(s.dir, 'files', 'CPRIV_5.5', 'a.csv')
    writeFileSync(csv, 'a,b\n1,2\n')
    const r = await s.call('send_file', { channel: 'CPRIV', thread_ts: '5.5', path: csv })
    assert.equal(r.isError, true)
    assert.match(r.text, /in the thread instead/)
  })
  test("telling people opens the group DM of exactly them and posts as the owner, and the post can be edited", async () => {
    const s = setup()
    s.t.onTask(s.task())
    const r = await s.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001', 'USAM00001'], text: 'We meet at 3 pm about growth.' })
    assert.equal(r.isError, undefined)
    assert.ok(s.calls.includes('owner open UBO000001,USAM00001'))
    assert.ok(s.calls.includes('owner post G-UBO000001,USAM00001 *Kage:* We meet at 3 pm about growth.'))
    assert.match(r.text, /https:\/\/x\/G-UBO000001,USAM00001\//)
    assert.equal((await s.call('edit_message', { channel: 'G-UBO000001,USAM00001', ts: '9.1', text: 'We meet at 4 pm.' })).text, 'edited')
    // Sent from the owner's account, so the edit keeps saying it was Kage.
    assert.ok(s.calls.includes('owner edit G-UBO000001,USAM00001 9.1 *Kage:* We meet at 4 pm.'), s.calls.join('\n'))
  })
  test("on a teammate's task the asker is always in the group, the message says who asked, and secrets stay out", async () => {
    const s = setup()
    s.t.onTask({ ...s.task({ fromOwner: false }), content: 'Teammate task (USAM00001, Sam, not the owner): tell Bo we meet at 3' })
    await s.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001'], text: 'We meet at 3 pm.' })
    assert.ok(s.calls.includes('owner open UBO000001,USAM00001'))
    assert.ok(s.calls.includes('owner post G-UBO000001,USAM00001 *Kage:* We meet at 3 pm.\n_asked by Sam_'))
    // An edit keeps the tag and the look of the first post.
    assert.equal((await s.call('edit_message', { channel: 'G-UBO000001,USAM00001', ts: '9.1', text: 'Sam approves the discount.' })).text, 'edited')
    assert.ok(s.calls.includes('owner edit G-UBO000001,USAM00001 9.1 *Kage:* Sam approves the discount.\n_asked by Sam_'))
    assert.equal((await s.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001'], text: 'key AKIAABCDEFGHIJKLMNOP' })).isError, true)
  })
  test("another session cannot edit or delete what message_people posted, even in a group DM it also messaged", async () => {
    const a = setup()
    a.t.onTask(a.task())
    await a.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001', 'USAM00001'], text: 'from the owner' })
    const b = setup({ dir: a.dir })
    b.t.onTask({ ...b.task({ fromOwner: false }), content: 'Teammate task (USAM00001, Sam, not the owner): x' })
    await b.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'On it', mark: 'ack' })   // b's own posts start at 9.2
    await b.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001'], text: 'hi' })
    assert.ok(b.calls.includes('owner post G-UBO000001,USAM00001 *Kage:* hi\n_asked by Sam_'))
    assert.equal((await b.call('edit_message', { channel: 'G-UBO000001,USAM00001', ts: '9.1', text: 'changed' })).isError, true)
    assert.equal((await b.call('delete_message', { channel: 'G-UBO000001,USAM00001', ts: '9.1' })).isError, true)
    // Not even a session whose task came from that group DM itself.
    const c = setup({ dir: a.dir })
    c.t.onTask(c.task({ channel: 'G-UBO000001,USAM00001' }))
    assert.equal((await c.call('edit_message', { channel: 'G-UBO000001,USAM00001', ts: '9.1', text: 'changed' })).isError, true)
  })
  test("the owner can pass on someone else's message: it is signed with their name, and they are in the group", async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001'], from: 'USAM00001', text: 'We meet at 3 pm.' })
    assert.ok(s.calls.includes('owner open UBO000001,USAM00001'))
    assert.ok(s.calls.includes('owner post G-UBO000001,USAM00001 *Kage:* We meet at 3 pm.\n_asked by Sam_'), s.calls.join('\n'))
  })
  test("a teammate cannot sign a message with someone else's name", async () => {
    const s = setup()
    s.t.onTask({ ...s.task({ fromOwner: false }), content: 'Teammate task (USAM00001, Sam, not the owner): x' })
    await s.call('message_people', { channel: 'C1', thread_ts: '5.5', users: ['UBO000001'], from: 'UBOSS0001', text: 'hi' })
    assert.ok(s.calls.includes('owner post G-UBO000001,USAM00001 *Kage:* hi\n_asked by Sam_'))
  })
  test("a non-owner task whose line names no teammate still gets the tag", async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'C9', fromOwner: false }))
    await s.call('message_people', { channel: 'C9', thread_ts: '5.5', users: ['UBO000001'], text: 'hi' })
    assert.ok(s.calls.includes('owner post G-UBO000001 *Kage:* hi\n_asked by A teammate_'))
  })
  test('telling people is refused from a thread with no task, for a bad id, a crowd, or without the scope', async () => {
    const s = setup()
    s.t.onTask(s.task())
    const no = (users: string[], channel = 'C1') => s.call('message_people', { channel, thread_ts: '5.5', users, text: 'hi' })
    assert.equal((await no(['UBO000001'], 'COTHER')).isError, true)
    s.t.onTask(s.task({ channel: 'email', fromOwner: false }))
    assert.equal((await no(['UBO000001'], 'email')).isError, true)
    assert.equal((await no(['C0CHANNEL1'])).isError, true)
    assert.equal((await no([])).isError, true)
    assert.equal((await no(Array.from({ length: 9 }, (_, i) => `UPERSON0${i}`))).isError, true)
    assert.match((await no(['UNOSCOPE'])).text, /mpim:write/)
    assert.ok(!s.calls.some(c => c.includes(' post ')))
  })
  test('edit and delete work only on what this session posted, with the token that posted it', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'CPRIV' }))
    await s.call('reply', { channel: 'CPRIV', thread_ts: '5.5', text: 'v1' })
    assert.equal((await s.call('edit_message', { channel: 'CPRIV', ts: '9.1', text: 'v2' })).text, 'edited')
    assert.ok(s.calls.includes('owner edit CPRIV 9.1 *Kage:* v2'))
    assert.equal((await s.call('edit_message', { channel: 'CPRIV', ts: '0.1', text: 'x' })).isError, true)   // not ours
    assert.equal((await s.call('delete_message', { channel: 'COTHER', ts: '9.1' })).isError, true)          // not this session's
    assert.equal((await s.call('delete_message', { channel: 'CPRIV', ts: '9.1' })).text, 'deleted')
    assert.equal((await s.call('delete_message', { channel: 'CPRIV', ts: '9.1' })).isError, true)           // already gone
  })
  test('email and WhatsApp replies are handed to the hub, not posted', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'email', thread_ts: 'mail:<r@x>' }))
    assert.equal((await s.call('reply', { channel: 'email', thread_ts: 'mail:<r@x>', text: 'hi' })).text, 'sent by email')
    assert.deepEqual(s.out, ['mail hi'])
  })
  test('a reply the hub cannot take (it is restarting) fails, so the session tries again instead of believing it went', async () => {
    const s = setup({ hubDown: true })
    s.t.onTask(s.task({ channel: 'email', thread_ts: 'mail:<r@x>' }))
    const r = await s.call('reply', { channel: 'email', thread_ts: 'mail:<r@x>', text: 'hi' })
    assert.equal(r.isError, true)
    assert.match(r.text, /restarting/)
    s.t.onTask(s.task({ channel: 'voice', thread_ts: 'voice:abc', fromOwner: false }))
    assert.equal((await s.call('reply', { channel: 'voice', thread_ts: 'voice:abc', text: 'hi' })).isError, true)
  })
  test('a voice reply is handed to the hub, never posted, and cannot go to the owner DM', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'voice', thread_ts: 'voice:abc', fromOwner: false }))
    assert.equal((await s.call('reply', { channel: 'voice', thread_ts: 'voice:abc', text: 'hi', private: true })).isError, true)
    assert.equal((await s.call('reply', { channel: 'voice', thread_ts: 'voice:abc', text: 'hi' })).text, 'spoken to the caller')
    assert.deepEqual(s.out, ['voice hi'])
    assert.deepEqual(s.calls, [])
  })
  test('the instructions limit a voice call to the reply tool and to nothing private', () => {
    const i = setup().t.instructions
    assert.match(i, /Voice task/)
    assert.match(i, /people on the owner's call/)
    assert.match(i, /share nothing private/)
    assert.match(i, /check with the owner/)
    assert.match(i, /no tool except reply/)
  })
  test('a private reply is logged as posted by the thread it answers', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'just for you', private: true })
    assert.match(s.ledgers.text('posted'), /\tDBOT\t[^\t]+\tbot\tC1:5\.5\n/)
  })
  test('a private reply goes into the DM thread the owner answered in, until a task comes from elsewhere', async () => {
    const s = setup()
    s.t.onTask({ ...s.task(), origin: { channel: 'C1', ts: '5.6', thread: '5.5' } })   // a channel thread reply is not a DM thread
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'first', private: true })
    s.t.onTask({ ...s.task(), origin: { channel: 'DBOT', ts: '8.2', thread: '8.1' } })
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'second', private: true })
    s.t.onTask({ ...s.task(), origin: { channel: 'C1', ts: '' }, scheduled: true })    // a scheduled run keeps the DM thread
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'reminder', private: true })
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'third', private: true })
    assert.deepEqual(s.posts.map(p => `${p.channel} ${p.thread_ts ?? '-'} ${p.text}`), ['DBOT - first', 'DBOT 8.1 second', 'DBOT 8.1 reminder', 'DBOT - third'])
  })
  test('an open question lands on the waiting list, and the next task in that thread closes it', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'PR?', waiting: 'Open a PR?' })
    assert.match((await s.call('waiting', {})).text, /Open a PR\?/)
    s.t.onTask(s.task())
    assert.equal((await s.call('waiting', {})).text, 'nothing is waiting')
    assert.match(s.ledgers.text('posted'), /C1\t9\.1\tbot\tC1:5\.5\n/)
  })
  test('a scheduled run in the thread does not answer its open question', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'PR?', waiting: 'Open a PR?' })
    s.t.onTask({ ...s.task(), origin: { channel: 'C1', ts: '' }, scheduled: true })
    assert.match((await s.call('waiting', {})).text, /Open a PR\?/)
    s.t.onTask({ ...s.task(), origin: { channel: 'C1', ts: '' } })   // kage tell: the owner, with no Slack message behind it
    assert.equal((await s.call('waiting', {})).text, 'nothing is waiting')
  })
  test('a task logs an answer only when its thread had an open question', async () => {
    const s = setup()
    s.t.onTask(s.task())
    s.t.onTask(s.task())
    assert.doesNotMatch(s.ledgers.text('waiting'), /answered/)
  })
  test('away and back switch AFK on the owner\'s task only', async () => {
    const s = setup()
    s.t.onTask(s.task({ fromOwner: false }))
    assert.equal((await s.call('away', { channel: 'C1', thread_ts: '5.5', minutes: 60 })).isError, true)
    assert.equal((await s.call('back', { channel: 'C1', thread_ts: '5.5' })).isError, true)
    s.t.onTask(s.task())
    assert.equal((await s.call('away', { channel: 'C1', thread_ts: '5.5', minutes: 60, note: 'lunch' })).text, 'AFK on')
    assert.equal((await s.call('away', { channel: 'C1', thread_ts: '5.5', until: '6pm' })).isError, true)
    await s.call('back', { channel: 'C1', thread_ts: '5.5' })
    assert.deepEqual(s.out, ['afk {"kind":"afk","note":"lunch","minutes":60}', 'afk {"kind":"back"}'])
  })
})
