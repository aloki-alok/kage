import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionTools } from './kage-tools.ts'
import type { Task } from './protocol.ts'

// A fake Slack: records posts, edits, deletes and reactions; the bot is not in channel "CPRIV".
function fakeSlack() {
  const calls: string[] = []
  let n = 0
  const client = (who: string) => ({
    chat: {
      postMessage: async (a: { channel: string; text: string }) => {
        if (who === 'bot' && a.channel === 'CPRIV') throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })
        calls.push(`${who} post ${a.channel} ${a.text}`)
        return { ts: `9.${++n}` }
      },
      update: async (a: { channel: string; ts: string; text: string }) => { calls.push(`${who} edit ${a.channel} ${a.ts} ${a.text}`) },
      delete: async (a: { channel: string; ts: string }) => { calls.push(`${who} delete ${a.channel} ${a.ts}`) },
    },
    filesUploadV2: async (a: { channel_id: string; thread_ts: string; filename: string }) => {
      if (a.channel_id === 'CPRIV') throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })
      calls.push(`${who} file ${a.channel_id} ${a.thread_ts} ${a.filename}`)
      return {}
    },
    reactions: { add: async (a: { channel: string; name: string }) => { calls.push(`${who} react ${a.channel} ${a.name}`) } },
    users: { info: async () => ({ user: { real_name: 'Sam' } }) },
  })
  return { calls, bot: client('bot'), user: client('owner') }
}

function setup() {
  const slack = fakeSlack()
  const dir = mkdtempSync(join(tmpdir(), 'kage-tools-'))
  const out: string[] = []
  const jobs: any[] = []
  const t = sessionTools({
    title: 'Kage', bot: slack.bot as any, user: slack.user as any, botDm: () => 'DBOT', dir, send: m => out.push(`${m.type} ${m.text}`), memory: { own: '/own', owner: '/owner' },
    schedules: {
      add: j => { jobs.push({ ...j, key: 'C1:5.5', created: 0, lastFired: 0 }) },
      remove: id => { jobs.splice(jobs.findIndex(j => j.id === id), 1) },
      list: () => jobs,
    },
  })
  const call = (name: string, args: Record<string, unknown>) => t.tools.find(x => x.name === name)!.run(args)
  const task = (o: Partial<Task['meta']> & { fromOwner?: boolean } = {}): Task => ({
    type: 'task', content: 'Task from Sam: hi', fromOwner: o.fromOwner ?? true,
    meta: { channel: o.channel ?? 'C1', thread_ts: o.thread_ts ?? '5.5', place: '#general', permalink: 'https://x/p' },
    origin: { channel: o.channel ?? 'C1', ts: '5.5' },
  })
  return { ...slack, dir, out, t, call, task, jobs }
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
    assert.match(r.text, /^Scheduled recurring job ([0-9a-f]{8})/)
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
  test('email replies are handed to the hub, not posted', async () => {
    const s = setup()
    s.t.onTask(s.task({ channel: 'email', thread_ts: 'mail:<r@x>' }))
    assert.equal((await s.call('reply', { channel: 'email', thread_ts: 'mail:<r@x>', text: 'hi' })).text, 'sent by email')
    assert.deepEqual(s.out, ['mail hi'])
  })
  test('an open question lands on the waiting list, and the next task in that thread closes it', async () => {
    const s = setup()
    s.t.onTask(s.task())
    await s.call('reply', { channel: 'C1', thread_ts: '5.5', text: 'PR?', waiting: 'Open a PR?' })
    assert.match((await s.call('waiting', {})).text, /Open a PR\?/)
    s.t.onTask(s.task())
    assert.equal((await s.call('waiting', {})).text, 'nothing is waiting')
    assert.match(readFileSync(join(s.dir, 'posted.tsv'), 'utf8'), /C1\t9\.1\tbot/)
  })
})
