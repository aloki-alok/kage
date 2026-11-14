#!/usr/bin/env node
// An ssh ProxyCommand for hosts behind AWS SSM: ssm-proxy.ts <instance id> <port> [region]. A sandboxed Kage session cannot reach AWS
// itself, so this asks the hub to (runtime/ssm-relay.ts). The token and socket come from the session's env.
import { connect } from 'node:net'

const [target, port, region] = process.argv.slice(2)
const { KAGE_SSM_TOKEN: token, KAGE_SSM_SOCK: path } = process.env
const die = (why: string) => { process.stderr.write(`kage ssm: ${why}\n`); process.exit(1) }
if (!token || !path) die('KAGE_SSM_TOKEN is not set: this ssh is not running inside an owner thread of Kage')
if (!target || !port) die('usage: ssm-proxy.ts <instance id> <port> [region]')

const s = connect({ path: path!, allowHalfOpen: true })
let head = ''
s.on('connect', () => s.write(`${token} ${target} ${port}${region ? ` ${region}` : ''}\n`))
s.on('error', e => die(`cannot reach the hub: ${e.message}`))
s.on('data', function onData(chunk) {
  head += chunk.toString('binary')
  const i = head.indexOf('\n')
  if (i < 0) return
  s.off('data', onData)
  if (head.slice(0, i) !== 'ok') die(head.slice(0, i).replace(/^error: /, ''))
  process.stdout.write(Buffer.from(head.slice(i + 1), 'binary'))
  s.pipe(process.stdout)
  process.stdin.pipe(s)
})
s.on('end', () => { if (!head.includes('\n')) die('the hub closed the connection') })
