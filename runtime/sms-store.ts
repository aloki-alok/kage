import { DatabaseSync } from 'node:sqlite'
import { campaignMove, nextStatus, type CampaignAction, type CampaignNumbers, type CampaignState, type SmsKeyword, type SmsStatus } from '../core/sms.ts'

export type SmsStore = ReturnType<typeof openSmsStore>
export type SmsCampaign = { id: number; name: string; state: CampaignState; body: string; thread: string; created: string }
export type SmsSend = { campaign: number; person: number; phone: string; body: string }
type Now = () => string

const BILLED: SmsStatus[] = ['queued', 'sent', 'delivered', 'undelivered']
const SCHEMA = `create table if not exists sms_people (id integer primary key, phone text not null unique);
  create table if not exists sms_campaigns (
    id integer primary key, name text not null, state text not null, body text not null, thread text not null,
    created_at text not null, launched_at text, finished_at text);
  create table if not exists sms_contacts (
    campaign_id integer not null, person_id integer not null, primary key (campaign_id, person_id));
  create table if not exists sms_messages (
    id integer primary key, campaign_id integer, person_id integer not null, direction text not null,
    provider_id text, status text not null, error_code text, keyword text, segments integer not null, at text not null);
  create unique index if not exists sms_out_once on sms_messages (campaign_id, person_id) where direction = 'out' and campaign_id is not null;
  create unique index if not exists sms_provider on sms_messages (direction, provider_id) where provider_id is not null;
  create index if not exists sms_by_person on sms_messages (person_id, id);
  create table if not exists sms_optouts (person_id integer primary key, at text not null)`

export function openSmsStore(file: string, now: Now = () => new Date().toISOString()) {
  const db = new DatabaseSync(file, { timeout: 5000 })
  db.exec('pragma journal_mode = wal')
  db.exec(SCHEMA)
  const people = peopleIn(db)
  const campaigns = campaignsIn(db, now, people.person)
  return { ...people, ...campaigns, ...sendingIn(db, now), ...hearingIn(db, now, people.person), report: reportOf(db, campaigns.campaign), close: () => db.close() }
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('begin immediate')
  try { const out = work(); db.exec('commit'); return out } catch (e) { try { db.exec('rollback') } catch {} throw e }
}

function peopleIn(db: DatabaseSync) {
  const find = db.prepare('select id from sms_people where phone = ?')
  const add = db.prepare('insert into sms_people (phone) values (?) on conflict do nothing')
  const phone = db.prepare('select phone from sms_people where id = ?')
  return {
    person(number: string): number {
      add.run(number)
      return Number((find.get(number) as { id: number }).id)
    },
    phoneOf: (id: number) => (phone.get(id) as { phone: string } | undefined)?.phone,
  }
}

function campaignsIn(db: DatabaseSync, now: Now, person: (phone: string) => number) {
  const columns = 'id, name, state, body, thread, created_at as created'
  const one = db.prepare(`select ${columns} from sms_campaigns where id = ?`)
  const newest = db.prepare(`select ${columns} from sms_campaigns order by id desc limit ?`)
  const insert = db.prepare(`insert into sms_campaigns (name, state, body, thread, created_at) values (?, 'draft', ?, ?, ?)`)
  const addContact = db.prepare('insert or ignore into sms_contacts (campaign_id, person_id) values (?, ?)')
  const setState = db.prepare(`update sms_campaigns set state = ?,
    launched_at = case when ? = 'sending' and launched_at is null then ? else launched_at end,
    finished_at = case when ? in ('done', 'cancelled') then ? else finished_at end where id = ?`)
  const allSent = db.prepare(`select id from sms_campaigns k where state = 'sending' and not exists (
    select 1 from sms_contacts c where c.campaign_id = k.id and not exists (
      select 1 from sms_messages m where m.direction = 'out' and m.campaign_id = c.campaign_id and m.person_id = c.person_id
        and not (m.status = 'claimed' and m.provider_id is null)))`)

  const campaign = (id: number) => one.get(id) as SmsCampaign | undefined
  const move = (id: number, action: CampaignAction): CampaignState | undefined => {
    const current = campaign(id)
    const next = current && campaignMove(current.state, action)
    if (!next) return
    const at = now()
    setState.run(next, next, at, next, at, id)
    return next
  }
  return {
    campaign,
    move,
    campaigns: (limit: number) => newest.all(limit) as SmsCampaign[],
    createCampaign: (c: { name: string; body: string; thread: string; phones: string[] }) => inTransaction(db, () => {
      const id = Number(insert.run(c.name, c.body, c.thread, now()).lastInsertRowid)
      let added = 0
      for (const phone of c.phones) added += Number(addContact.run(id, person(phone)).changes)
      return { id, added, repeated: c.phones.length - added }
    }),
    sentCampaigns: (): number[] => (allSent.all() as { id: number }[]).map(({ id }) => Number(id)),
  }
}

function sendingIn(db: DatabaseSync, now: Now) {
  const skipOptedOut = db.prepare(`insert or ignore into sms_messages (campaign_id, person_id, direction, status, segments, at)
    select c.campaign_id, c.person_id, 'out', 'skipped', 0, ? from sms_contacts c
    join sms_campaigns k on k.id = c.campaign_id and k.state = 'sending'
    join sms_optouts o on o.person_id = c.person_id`)
  const pending = db.prepare(`select c.campaign_id as campaign, c.person_id as person, p.phone, k.body from sms_contacts c
    join sms_campaigns k on k.id = c.campaign_id and k.state = 'sending'
    join sms_people p on p.id = c.person_id
    where not exists (select 1 from sms_messages m where m.direction = 'out' and m.campaign_id = c.campaign_id and m.person_id = c.person_id)
    order by c.campaign_id, c.rowid limit ?`)
  const claimRow = db.prepare(`insert or ignore into sms_messages (campaign_id, person_id, direction, status, segments, at)
    select c, p, 'out', 'claimed', ?, ? from (select ? as c, ? as p)
    where not exists (select 1 from sms_optouts where person_id = p)
    and (c is null or exists (select 1 from sms_campaigns where id = c and state = 'sending'))`)
  const unclaim = db.prepare(`delete from sms_messages where id = ? and status = 'claimed' and provider_id is null`)
  const statusOf = db.prepare('select status from sms_messages where id = ?')
  const byProvider = db.prepare(`select id, status from sms_messages where direction = 'out' and provider_id = ?`)
  const writeStatus = db.prepare('update sms_messages set status = ?, error_code = coalesce(?, error_code) where id = ?')
  const writeProvider = db.prepare('update sms_messages set provider_id = ?, status = ? where id = ?')
  return {
    nextBatch(limit: number): SmsSend[] {
      skipOptedOut.run(now())
      return pending.all(limit) as SmsSend[]
    },
    claim(campaign: number | null, person: number, segments: number): number | undefined {
      const r = claimRow.run(segments, now(), campaign, person)
      return r.changes ? Number(r.lastInsertRowid) : undefined
    },
    accepted(row: number, providerId: string) {
      const current = (statusOf.get(row) as { status: SmsStatus } | undefined)?.status
      if (current) writeProvider.run(providerId, nextStatus(current, 'queued'), row)
    },
    refused: (row: number, code: string) => { writeStatus.run('failed', code, row) },
    release: (row: number) => { unclaim.run(row) },
    status(providerId: string, incoming: SmsStatus, error?: string): boolean {
      const row = byProvider.get(providerId) as { id: number; status: SmsStatus } | undefined
      if (!row) return false
      const next = nextStatus(row.status, incoming)
      if (next !== row.status) writeStatus.run(next, error ?? null, row.id)
      return true
    },
  }
}

function hearingIn(db: DatabaseSync, now: Now, person: (phone: string) => number) {
  const lastCampaign = db.prepare(`select campaign_id as campaign from sms_messages
    where person_id = ? and direction = 'out' and campaign_id is not null and status <> 'skipped' order by id desc limit 1`)
  const seen = db.prepare(`select campaign_id as campaign from sms_messages where direction = 'in' and provider_id = ?`)
  const insert = db.prepare(`insert into sms_messages (campaign_id, person_id, direction, provider_id, status, keyword, segments, at)
    values (?, ?, 'in', ?, 'delivered', ?, 0, ?)`)
  const addOptOut = db.prepare('insert into sms_optouts (person_id, at) values (?, ?) on conflict do nothing')
  const dropOptOut = db.prepare('delete from sms_optouts where person_id = ?')
  return {
    heard: (phone: string, providerId: string, keyword?: SmsKeyword): { person: number; campaign?: number; fresh: boolean } => inTransaction(db, () => {
      const id = person(phone)
      const before = seen.get(providerId) as { campaign: number | null } | undefined
      if (before) return { person: id, campaign: before.campaign ?? undefined, fresh: false }
      const campaign = (lastCampaign.get(id) as { campaign: number } | undefined)?.campaign
      insert.run(campaign ?? null, id, providerId, keyword ?? null, now())
      if (keyword === 'stop') addOptOut.run(id, now())
      if (keyword === 'start') dropOptOut.run(id)
      return { person: id, campaign, fresh: true }
    }),
    optOut: (id: number) => { addOptOut.run(id, now()) },
  }
}

function reportOf(db: DatabaseSync, campaign: (id: number) => SmsCampaign | undefined) {
  const contacts = db.prepare('select count(*) as n from sms_contacts where campaign_id = ?')
  const byStatus = db.prepare(`select status as k, count(*) as n from sms_messages where campaign_id = ? and direction = 'out' group by status`)
  const byError = db.prepare(`select error_code as k, count(*) as n from sms_messages where campaign_id = ? and direction = 'out' and error_code is not null group by error_code`)
  const replies = db.prepare(`select count(*) as n from sms_messages where campaign_id = ? and direction = 'in' and keyword is null`)
  const optOuts = db.prepare(`select count(*) as n from sms_messages where campaign_id = ? and direction = 'in' and keyword = 'stop'`)
  const segments = db.prepare(`select coalesce(sum(segments), 0) as n from sms_messages where campaign_id = ? and direction = 'out' and status in (${BILLED.map(s => `'${s}'`).join(', ')})`)
  const count = (q: typeof contacts, id: number) => Number((q.get(id) as { n: number }).n)
  const tally = (q: typeof contacts, id: number) => Object.fromEntries((q.all(id) as { k: string; n: number }[]).map(r => [r.k, Number(r.n)]))
  return (id: number): CampaignNumbers | undefined => {
    const c = campaign(id)
    if (!c) return
    return {
      name: c.name, state: c.state, contacts: count(contacts, id), counts: tally(byStatus, id), errors: tally(byError, id),
      replies: count(replies, id), optOuts: count(optOuts, id), segments: count(segments, id),
    }
  }
}
