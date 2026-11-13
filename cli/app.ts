// Lists, adds or removes the Slack apps of teammates' own agents (KAGE_TRUSTED_APPS). A tagged post from a
// listed app, made with a listed teammate's token, counts as that teammate's task. The hub reads the
// list when it starts, so a change applies at the next restart. Usage:
//   kage app list | add <app id> | remove <app id>
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { listIn, validAppId, withList } from '../core/gate.ts'
import { ENV_FILE } from './home.ts'

const LIST = 'KAGE_TRUSTED_APPS'
const die = (msg: string): never => { console.error(msg); process.exit(1) }
if (!existsSync(ENV_FILE)) die(`No settings file at ${ENV_FILE}. Run kage setup first.`)
const env = readFileSync(ENV_FILE, 'utf8')
const now = listIn(env, LIST)
// Inside a Kage session a restart would end that session, so only the owner's own terminal applies it.
const APPLY = process.env.KAGE_CLAUDE ? 'It applies when the owner runs kage restart in their own terminal.' : 'To apply it, run: kage restart'

const [cmd, raw = '', ...extra] = process.argv.slice(2)
const id = raw.toUpperCase()
if (cmd === 'list' && !raw) {
  if (!now.length) console.log("No trusted apps: a post from a teammate's agent is dropped.")
  for (const a of now) console.log(a)
} else if ((cmd === 'add' || cmd === 'remove') && raw && !extra.length) {
  if (!validAppId(id)) die(`"${raw}" is not a Slack app id. An app id starts with A, like A0123ABC. The agent's owner finds it at api.slack.com/apps, under Basic Information.`)
  const next = cmd === 'add' ? [...new Set([...now, id])] : now.filter(a => a !== id)
  if (next.length === now.length) {
    console.log(`${id} is ${cmd === 'add' ? 'already' : 'not'} a trusted app. Nothing changed.`)
  } else {
    // Write a copy, then swap it in: a crash mid-write never leaves a cut-off token file.
    writeFileSync(`${ENV_FILE}.new`, withList(env, LIST, next), { mode: 0o600 })
    renameSync(`${ENV_FILE}.new`, ENV_FILE)
    console.log(cmd === 'add'
      ? `Added ${id}. A tagged post from this app, made with a listed teammate's token, will count as that teammate's task. It never counts as yours.`
      : `Removed ${id}. Posts from this app will be dropped again.`)
    if (cmd === 'add' && !listIn(env, 'KAGE_TEAMMATES').length) console.log("No teammate is listed yet, so no post from this app can count. Add the agent's owner: kage teammate add <name>")
    console.log(APPLY)
  }
} else {
  die('Usage: kage app list | add <app id> | remove <app id>\nTo write the Slack app for Kage itself: kage app <name>')
}
