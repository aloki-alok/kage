// The session runtime: each thread runs Claude Code in a pane of one tiled tmux window, "threads",
// labelled with its place. A pane carries its session id in the tmux option @kage, which is how the
// hub finds it again after a restart.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { log } from '../config.ts'
import { liveCronJobs, type Windows } from '../core/sessions.ts'

export function tmuxWindows(o: {
  name: string
  envFile: string
  claude: string                              // the command start.sh built, with the kage channel
  idOf: (key: string) => string | undefined   // the thread's session id
  placeOf: (key: string) => string            // the pane's label
  onStart: () => void                         // a new id may have been minted: save the map
}) {
  const tmux = (...a: string[]) => execFileSync('tmux', a, { encoding: 'utf8' })
  // Claude Code keeps a session's transcript in a folder named after the working directory.
  // Its mtime is the session's last activity, and its existence means there is something to resume.
  const PROJECT = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^A-Za-z0-9]/g, '-')}`
  const BOARD = `=${o.name}:threads`

  // session id -> pane id
  const panes = (): Map<string, string> => {
    const lines = tmux('list-panes', '-s', '-t', `=${o.name}`, '-F', '#{@kage} #{pane_id}').split('\n')
    return new Map(lines.filter(l => /^\S+ %\d+$/.test(l)).map(l => l.split(' ') as [string, string]))
  }
  const paneOf = (key: string) => panes().get(o.idOf(key) ?? '')
  const hasBoard = () => tmux('list-windows', '-t', `=${o.name}`, '-F', '#{window_name}').split('\n').includes('threads')

  // The tool results in a session's transcript that mention a job (CronCreate, CronDelete).
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

  // When the Claude Code process in a pane started (the pane's shell loop is its parent).
  // No process (between restarts): Infinity, so no job counts as alive.
  function processStart(pane: string): number {
    try {
      const shell = tmux('display-message', '-p', '-t', pane, '#{pane_pid}').trim()
      const child = execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim().split('\n')[0]!
      return Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', child], { encoding: 'utf8' }).trim()) || Infinity
    } catch { return Infinity }
  }

  const windows: Windows = {
    start(key, id) {
      // Resume the thread's conversation once it has a transcript; until then, start it under that id.
      // The loop brings Claude Code back with the same conversation if it ever exits.
      const run = `while true; do if [ -f '${PROJECT}/${id}.jsonl' ]; then eval "$KAGE_CLAUDE --resume ${id}"; else eval "$KAGE_CLAUDE --session-id ${id}"; fi; echo 'restarting in 3s'; sleep 3; done`
      const where = hasBoard() ? ['split-window', '-d', '-t', BOARD] : ['new-window', '-d', '-t', `=${o.name}:`, '-n', 'threads']
      const pane = tmux(...where, '-P', '-F', '#{pane_id}', '-c', process.cwd(),
        '-e', `KAGE_THREAD=${key}`, '-e', `KAGE_ENV=${o.envFile}`, '-e', `KAGE_CLAUDE=${o.claude}`, run).trim()
      tmux('set-option', '-p', '-t', pane, '@kage', id)
      tmux('set-option', '-p', '-t', pane, '@kage_place', ` ${o.placeOf(key)} `)
      tmux('set-option', '-w', '-t', BOARD, 'pane-border-status', 'top')
      tmux('set-option', '-w', '-t', BOARD, 'pane-border-format', '#{@kage_place}')
      tmux('select-layout', '-t', BOARD, 'tiled')
      o.onStart()
      log('started', pane, 'for', o.placeOf(key))
    },
    stop(key) {
      const pane = paneOf(key)
      if (pane) tmux('kill-pane', '-t', pane)
      if (hasBoard()) tmux('select-layout', '-t', BOARD, 'tiled')
      log('closed', pane, 'for', key)
    },
    // The latest write by the session or by any of its subagents: a session that handed its work to
    // a background agent sits idle at its own prompt while the agent works.
    lastActivity(key) {
      const id = o.idOf(key)
      const files = [`${PROJECT}/${id}.jsonl`]
      try { files.push(...readdirSync(`${PROJECT}/${id}/subagents`).map(f => `${PROJECT}/${id}/subagents/${f}`)) } catch {}
      return Math.max(0, ...files.map(f => { try { return statSync(f).mtimeMs } catch { return 0 } }))
    },
    // ponytail: reads the bottom of Claude Code's screen: the spinner "… (12s", "· 2 shells" in the
    // status bar, or a running background agent listed as "◯ general-purpose  ...". A UI change makes
    // it miss, and then only the transcript times keep a long task alive.
    busy(key) {
      const pane = paneOf(key)
      if (!pane) return false
      const bottom = tmux('capture-pane', '-p', '-t', pane).split('\n').filter(l => l.trim()).slice(-20).join('\n')
      if (/… \(\d/.test(bottom) || /· \d+ shells?\b/.test(bottom) || /^\s*◯ /m.test(bottom)) return true
      // A repeating check (CronCreate) lives only in this Claude Code process: keep the pane for it.
      return liveCronJobs(cronResults(o.idOf(key)!), processStart(pane), Date.now()).length > 0
    },
  }

  return {
    windows,
    // Session ids with a pane right now.
    running: () => new Set(panes().keys()),
    // Claude Code deletes old transcripts (cleanupPeriodDays, 30 by default); without one there is nothing to resume.
    hasTranscript: (id: string) => existsSync(`${PROJECT}/${id}.jsonl`),
  }
}
