// Prints the Slack app manifest for the name in KAGE_NAME (setup.sh calls this).
import { validName } from './logic.ts'

const name = process.env.KAGE_NAME || 'kage'
if (!validName(name)) throw new Error(`bad name: ${name}`)
const Title = name[0]!.toUpperCase() + name.slice(1)

const manifest = {
  display_information: {
    name: Title,
    description: 'My Claude Code agent. Tag it in any thread and it works on my machine.',
    background_color: '#14121a',
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: name, always_online: true },
  },
  oauth_config: {
    scopes: {
      // The bot posts replies and approval prompts, and reacts with 👀.
      bot: ['chat:write', 'im:write', 'im:history', 'reactions:write', 'users:read'],
      // Your user token hears your conversations, reads the thread for context, and replies
      // where the bot isn't a member.
      user: [
        'channels:history', 'groups:history', 'im:history', 'mpim:history',
        'channels:read', 'groups:read', 'im:read', 'mpim:read',
        'chat:write', 'reactions:write', 'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}

process.stdout.write(JSON.stringify(manifest, null, 2))
