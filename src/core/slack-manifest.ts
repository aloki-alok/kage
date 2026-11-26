import { BOT_SCOPES, USER_SCOPES } from './slack-scopes.ts'

type ManifestFor = { name: string; transport: 'socket' } | { name: string; transport: 'http'; url: string; commands: string[] }

export function slackManifest(o: ManifestFor) {
  const http = o.transport === 'http' ? o : undefined
  const commands = http?.commands.map(command => ({ command, url: http.url, description: `Runs ${command} on Kage`, should_escape: false }))
  return {
    display_information: {
      name: o.name[0]!.toUpperCase() + o.name.slice(1),
      description: 'My Claude Code agent. Tag it in any thread and it works on my machine.',
      background_color: '#14121a',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: o.name, always_online: true },
      ...commands?.length && { slash_commands: commands },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES, user: USER_SCOPES } },
    settings: {
      event_subscriptions: { ...http && { request_url: http.url }, user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: !http,
      token_rotation_enabled: false,
    },
  }
}
