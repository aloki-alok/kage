import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { log } from './log.ts'
import { liveCronJobs } from '../core/cron.ts'
import type { Runner } from '../core/sessions.ts'

export function paneProcessStart(pane: string): number {
  try {
    const shell = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}'], { encoding: 'utf8' }).trim()
    const child = execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim().split('\n')[0]!
    return Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', child], { encoding: 'utf8' }).trim()) || Infinity
  } catch { return Infinity }
}

export const claudeProject = (cwd: string) => `${process.env.HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`

export function paneArgs(a: {
  key: string; id: string; project: string; cwd: string; envFile: string; claude: string
  settings: object; ssm?: { token: string; sock: string; shim: string }
}): string[] {
  const run = `while true; do if [ -f '${a.project}/${a.id}.jsonl' ]; then eval "$KAGE_CLAUDE --settings \"\$KAGE_PANE_SETTINGS\" --resume ${a.id}"; else eval "$KAGE_CLAUDE --settings \"\$KAGE_PANE_SETTINGS\" --session-id ${a.id}"; fi; echo 'restarting in 3s'; sleep 3; done`
  const env = [`KAGE_THREAD=${a.key}`, 'KAGE_SESSION=1', `KAGE_ENV=${a.envFile}`, `KAGE_CLAUDE=${a.claude}`, `KAGE_PANE_SETTINGS=${JSON.stringify(a.settings)}`,
    ...a.ssm ? [`KAGE_SSM_TOKEN=${a.ssm.token}`, `KAGE_SSM_SOCK=${a.ssm.sock}`, `PATH=${a.ssm.shim}:${process.env.PATH}`] : []]
  return ['-P', '-F', '#{pane_id}', '-c', a.cwd, ...env.flatMap(e => ['-e', e]), run]
}

export function tmuxPanes(o: {
  name: string
  envFile: string
  claude: string
  settings: () => object
  ssm?: { sock: string; shim: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  idOf: (key: string) => string | undefined
  placeOf: (key: string) => string
  onStart: () => void
}) {
  const tmux = (...a: string[]) => execFileSync('tmux', a, { encoding: 'utf8' })
  const PROJECT = claudeProject(process.cwd())
  const BOARD = `=${o.name}:threads`

  const panes = (): Map<string, string> => {
    let lines: string[]
    try { lines = tmux('list-panes', '-s', '-t', `=${o.name}`, '-F', '#{@kage} #{pane_id}').split('\n') } catch { return new Map() }
    return new Map(lines.filter(l => /^\S+ %\d+$/.test(l)).map(l => l.split(' ') as [string, string]))
  }
  const hasSession = () => { try { tmux('has-session', '-t', `=${o.name}`); return true } catch { return false } }
  const paneOf = (key: string) => panes().get(o.idOf(key) ?? '')
  const hasBoard = () => hasSession() && tmux('list-windows', '-t', `=${o.name}`, '-F', '#{window_name}').split('\n').includes('threads')

  function cronResults(id: string): { timestamp: string; text: string }[] {
    let raw = ''
    try { raw = readFileSync(`${PROJECT}/${id}.jsonl`, 'utf8') } catch { return [] }
    const out: { timestamp: string; text: string }[] = []
    for (const line of raw.split('\n')) {
      if (!line.includes(' job ')) continue
      let r: any
      try { r = JSON.parse(line) } catch { continue }
      const content = r?.message?.content
      if (!r.timestamp || !Array.isArray(content)) continue
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c?.text ?? '').join('')
        out.push({ timestamp: r.timestamp, text })
      }
    }
    return out
  }

  const runner: Runner = {
    outlivesHub: () => true,
    start(key, id) {
      const where = hasBoard() ? ['split-window', '-d', '-t', BOARD]
        : hasSession() ? ['new-window', '-d', '-t', `=${o.name}:`, '-n', 'threads']
        : ['new-session', '-d', '-s', o.name, '-n', 'threads']
      const token = o.ssm?.issue(key)
      const pane = tmux(...where, ...paneArgs({ key, id, project: PROJECT, cwd: process.cwd(), envFile: o.envFile, claude: o.claude, settings: o.settings(),
        ...token && { ssm: { token, sock: o.ssm!.sock, shim: o.ssm!.shim } } })).trim()
      tmux('set-option', '-p', '-t', pane, '@kage', id)
      tmux('set-option', '-p', '-t', pane, '@kage_place', ` ${o.placeOf(key)} `)
      tmux('set-option', '-w', '-t', BOARD, 'pane-border-status', 'top')
      tmux('set-option', '-w', '-t', BOARD, 'pane-border-format', '#{@kage_place}')
      tmux('select-layout', '-t', BOARD, 'tiled')
      o.onStart()
      log('started', pane, 'for', o.placeOf(key))
    },
    stop(key) {
      o.ssm?.drop(key)
      const pane = paneOf(key)
      if (pane) tmux('kill-pane', '-t', pane)
      if (hasBoard()) tmux('select-layout', '-t', BOARD, 'tiled')
      log('closed', pane, 'for', key)
    },
    lastActivity(key) {
      const id = o.idOf(key)
      const files = [`${PROJECT}/${id}.jsonl`]
      try { files.push(...readdirSync(`${PROJECT}/${id}/subagents`).map(f => `${PROJECT}/${id}/subagents/${f}`)) } catch {}
      return Math.max(0, ...files.map(f => { try { return statSync(f).mtimeMs } catch { return 0 } }))
    },
    busy(key) {
      const pane = paneOf(key)
      if (!pane) return false
      const bottom = tmux('capture-pane', '-p', '-t', pane).split('\n').filter(l => l.trim()).slice(-20).join('\n')
      if (/… \(\d/.test(bottom) || /· \d+ shells?\b/.test(bottom) || /^\s*◯ /m.test(bottom)) return true
      return liveCronJobs(cronResults(o.idOf(key)!), paneProcessStart(pane), Date.now()).length > 0 ? 'watching' : false
    },
  }

  return {
    runner,
    running: () => new Set(panes().keys()),
    hasTranscript: (id: string) => existsSync(`${PROJECT}/${id}.jsonl`),
  }
}
