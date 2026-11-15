// What a session needs to start: the shell sandbox, the ssh relay, and the Agent SDK (or the tmux plugin route).
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { keyLines, pluginLine, sandboxLine, sessionLines } from '../../core/doctor.ts'
import { config, onPath, read, ROOT, runtime, sh, type Group } from './context.ts'

const executable = (f: string) => { try { accessSync(f, constants.X_OK); return true } catch { return false } }

export const session: Group = async () => {
  if (runtime === 'tmux') {
    const list = sh('claude', ['plugin', 'list', '--json']).stdout
    const plugin = (() => { try { return (JSON.parse(list) as { id: string; enabled: boolean }[]).some(p => p.id === 'kage@kage' && p.enabled) } catch { return false } })()
    const remote = (() => { try { return JSON.parse(read(`${homedir()}/.claude/remote-settings.json`) ?? '{}') as { allowedChannelPlugins?: { marketplace: string; plugin: string }[] } } catch { return {} } })()
    const orgApproved = (remote.allowedChannelPlugins ?? []).some(p => p.marketplace === 'kage' && p.plugin === 'kage')
    return sessionLines({ root: ROOT, runtime, route: config.harness?.route ?? undefined, plugin, orgApproved })
  }
  const sdkLoads = await import('@anthropic-ai/claude-agent-sdk').then(() => true, () => false)
  return [
    sandboxLine({ platform: process.platform, sandboxExec: executable('/usr/bin/sandbox-exec'), bwrap: onPath('bwrap'), socat: onPath('socat') }),
    pluginLine(onPath('session-manager-plugin')),
    ...keyLines(config.sessionKeys),
    ...sessionLines({ runtime, sdkLoads }),
  ]
}
