import { validName } from '../core/gate.ts'
import { slackManifest } from '../core/slack-manifest.ts'
import { SLACK_PATH, slackTransport } from '../core/slack-transport.ts'
import { settings } from './home.ts'
import { tunnelUrl } from './tailscale.ts'

const name = process.env.KAGE_NAME || 'kage'
if (!validName(name)) throw new Error(`bad name: ${name}`)
const s = settings()

if (slackTransport(s) === 'socket') process.stdout.write(JSON.stringify(slackManifest({ name, transport: 'socket' }), null, 2))
else {
  const url = s.config.slack?.publicUrl ?? tunnelUrl(s.config, SLACK_PATH)
  if (!url) { console.error('Slack is set to HTTP, but no public route reaches Kage. Run kage tunnel on, or set slack.publicUrl.'); process.exit(1) }
  const commands = Object.keys(s.config.connectors?.commands ?? {})
  process.stdout.write(JSON.stringify(slackManifest({ name, transport: 'http', url, commands }), null, 2))
}
