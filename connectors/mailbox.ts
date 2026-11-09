// The email side of the router: SES receives mail for Kage's address into S3 and notifies an
// SQS queue. This polls the queue, checks each mail with mail.ts, and sends replies through SES.
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { dkimVerify } from 'mailauth/lib/dkim/verify.js'
import { simpleParser, type AddressObject } from 'mailparser'
import { promises as dns } from 'node:dns'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { log } from '../config.ts'
import type { Inbox } from '../runtime/store.ts'
import { composeReply, mailTask, replyTargets, type InboundMail, type MailConfig } from './mail.ts'

type Thread = { mail: InboundMail }
export type MailTaskOut = { key: string; sender: 'owner' | 'teammate'; from: string; subject: string; ask: string; quoted: string }

const addrs = (a?: AddressObject | AddressObject[]) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap(x => x.value.map(v => v.address ?? '')).filter(Boolean)
// DKIM keys are TXT answers too big for plain UDP. Home routers often drop those (no EDNS, no TCP),
// so Node's lookup times out and every mail fails its signature check. Public resolvers serve them.
const resolver = new dns.Resolver({ timeout: 5000, tries: 2 })
resolver.setServers(['1.1.1.1', '8.8.8.8', ...dns.getServers()])
const dkimResolver = (name: string, rr: string) => resolver.resolve(name, rr) as Promise<string[] | string[][]>
const list = (v?: string | string[]) => (Array.isArray(v) ? v : v ? v.split(/\s+/) : []).filter(Boolean)

export function startMailbox(o: {
  env: Record<string, string>; dir: string; cfg: MailConfig; inbox: Inbox; onTask: (t: MailTaskOut) => void
}) {
  const region = o.env.KAGE_AWS_REGION || 'us-west-1'
  const credentials = { accessKeyId: o.env.KAGE_AWS_ACCESS_KEY_ID!, secretAccessKey: o.env.KAGE_AWS_SECRET_ACCESS_KEY! }
  const sqs = new SQSClient({ region, credentials })
  const s3 = new S3Client({ region, credentials })
  const ses = new SESv2Client({ region, credentials })
  const queue = o.env.KAGE_MAIL_QUEUE!
  const THREADS = `${o.dir}/mail-threads.json`
  const threads: Record<string, Thread> = existsSync(THREADS) ? JSON.parse(readFileSync(THREADS, 'utf8')) : {}
  const save = () => writeFileSync(THREADS, JSON.stringify(threads), { mode: 0o600 })

  async function handle(body: string) {
    const n = JSON.parse(body)
    if (n.notificationType !== 'Received') return
    const r = n.receipt
    const res = await s3.send(new GetObjectCommand({ Bucket: r.action.bucketName, Key: r.action.objectKey }))
    const raw = Buffer.from(await res.Body!.transformToByteArray())
    const [dk, p] = await Promise.all([dkimVerify(raw, { resolver: dkimResolver }), simpleParser(raw)])
    const mail: InboundMail = {
      verdicts: { spam: r.spamVerdict?.status, virus: r.virusVerdict?.status, dmarc: r.dmarcVerdict?.status },
      dkim: dk.results.map((x: any) => ({ domain: x.signingDomain ?? '', selector: x.selector ?? '', pass: x.status?.result === 'pass' })),
      from: addrs(p.from)[0] ?? '',
      to: addrs(p.to),
      cc: addrs(p.cc),
      messageId: p.messageId ?? n.mail.messageId,
      inReplyTo: p.inReplyTo,
      references: list(p.references),
      subject: p.subject ?? '',
      text: p.text ?? '',
    }
    // SQS delivers at least once: a Message-ID already in the inbox is a repeat. Only the id is kept,
    // since SQS itself holds the mail until it is deleted after handling.
    if (!o.inbox.take(`mail:${mail.messageId}`, 'mail', null)) return
    const t = mailTask(mail, o.cfg)
    if ('drop' in t) {
      log('mail dropped:', mail.from, JSON.stringify(mail.subject), t.drop)
      return
    }
    threads[t.key] = { mail }
    save()
    o.onTask({ key: t.key, sender: t.sender, from: mail.from, subject: mail.subject, ask: t.ask, quoted: t.quoted })
  }

  async function poll() {
    for (;;) {
      try {
        const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 20, MaxNumberOfMessages: 5 }))
        for (const m of res.Messages ?? []) {
          // A mail that fails to process is logged and dropped, not retried forever.
          await handle(m.Body ?? '{}').catch(e => log('mail handling failed', e))
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle }))
        }
      } catch (e) {
        log('mail poll failed', e)
        await new Promise(r => setTimeout(r, 30_000))
      }
    }
  }
  void poll()

  // Reply-all within our domains, threaded under the latest mail that tagged Kage.
  return async function send(key: string, text: string): Promise<void> {
    const t = threads[key]
    if (!t) throw new Error(`no mail thread ${key}`)
    const { to, cc } = replyTargets(t.mail, o.cfg)
    const raw = composeReply({
      from: `${o.cfg.name[0]!.toUpperCase()}${o.cfg.name.slice(1)} <${o.cfg.self}>`, to, cc, subject: t.mail.subject,
      inReplyTo: t.mail.messageId, references: [...t.mail.references, t.mail.messageId], text,
    })
    await ses.send(new SendEmailCommand({ FromEmailAddress: o.cfg.self, Content: { Raw: { Data: Buffer.from(raw) } } }))
    log('mail sent for', key, 'to', [...to, ...cc].join(','))
  }
}
