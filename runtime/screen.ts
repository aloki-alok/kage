import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

export type Launch = (app: string, log: string) => { exited: Promise<number | null> }
type Line = { state?: 'recording' | 'saved'; pid?: number; seconds?: number; error?: string }
type Running = { pid: number; out: string; log: string; exited: Promise<number | null>; done: boolean }

const PERMISSION = "macOS needs the owner's yes first. It asked them to turn on Kage Screen in System Settings > Privacy & Security > Screen & System Audio Recording. Tell the owner, and try again once they have."
const run = promisify(execFile)

export async function buildApp(code: string, app: string): Promise<string | undefined> {
  const swift = `${code}/screen/KageScreen.swift`, plist = `${code}/screen/Info.plist`, stamp = `${dirname(app)}/source-hash`
  const hash = createHash('sha256').update(readFileSync(swift)).update(readFileSync(plist)).digest('hex')
  if (existsSync(`${app}/Contents/MacOS/KageScreen`) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return undefined
  try {
    rmSync(app, { recursive: true, force: true })
    mkdirSync(`${app}/Contents/MacOS`, { recursive: true, mode: 0o700 })
    await run('swiftc', ['-O', '-o', `${app}/Contents/MacOS/KageScreen`, swift], { timeout: 300_000 })
    copyFileSync(plist, `${app}/Contents/Info.plist`)
    await run('codesign', ['-s', '-', '--force', app], { timeout: 60_000 })
    writeFileSync(stamp, hash, { mode: 0o600 })
    return undefined
  } catch (e) {
    return `could not build Kage Screen, which needs the Xcode Command Line Tools (xcode-select --install): ${String((e as { stderr?: string }).stderr || e).split('\n')[0]}`
  }
}

const openApp: Launch = (app, log) => {
  const child = spawn('/usr/bin/open', ['-W', '-n', '-g', '--stdout', log, '--stderr', '/dev/null', app], { stdio: 'ignore' })
  return { exited: new Promise(done => { child.on('exit', done); child.on('error', () => done(null)) }) }
}

export function screenRecorder(o: { dir: string; code: string; build?: (app: string) => Promise<string | undefined>; launch?: Launch; kill?: (pid: number) => void; pollMs?: number }) {
  const app = `${o.dir}/Kage Screen.app`
  const build = o.build ?? (a => buildApp(o.code, a))
  const launch = o.launch ?? openApp, kill = o.kill ?? (pid => { try { process.kill(pid, 'SIGINT') } catch {} })
  const pollMs = o.pollMs ?? 100
  let current: Running | undefined
  let busy = Promise.resolve()

  const lines = (log: string): Line[] => {
    let text = ''
    try { text = readFileSync(log, 'utf8') } catch { return [] }
    return text.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v as Line] : [] } catch { return [] } })
  }
  const failure = (l: Line | undefined) => l?.error === 'permission' ? PERMISSION : `Kage Screen: ${l?.error ?? 'it stopped and said nothing'}`

  async function launchJob(job: { action: 'record' | 'shot'; out: string; seconds?: number; app?: string }) {
    const err = await build(app)
    if (err) return { err }
    mkdirSync(o.dir, { recursive: true, mode: 0o700 })
    const log = `${o.dir}/out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
    writeFileSync(log, '', { mode: 0o600 })
    writeFileSync(`${o.dir}/job.json`, JSON.stringify(job), { mode: 0o600 })
    const { exited } = launch(app, log)
    let ended = false
    void exited.then(() => { ended = true })
    for (let waited = 0; waited < 30_000; waited += pollMs) {
      const first = lines(log)[0]
      if (first || ended) return { log, exited, first: first ?? lines(log)[0], ended }
      await new Promise(r => setTimeout(r, pollMs))
    }
    return { log, exited, first: undefined, ended }
  }
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = busy.then(f); busy = p.then(() => {}, () => {}); return p }

  return {
    shot: (out: string, appName?: string) => serial(async (): Promise<string | undefined> => {
      const r = await launchJob({ action: 'shot', out, ...appName && { app: appName } })
      if ('err' in r) return r.err
      await r.exited
      const last = lines(r.log).at(-1)
      rmSync(r.log, { force: true })
      return last?.state === 'saved' ? undefined : failure(last)
    }),
    start: (out: string, seconds: number, appName?: string) => serial(async (): Promise<string | undefined> => {
      if (current && !current.done) return 'already recording: stop that recording first'
      const r = await launchJob({ action: 'record', out, seconds, ...appName && { app: appName } })
      if ('err' in r) return r.err
      if (r.first?.state !== 'recording' || !r.first.pid) {
        rmSync(r.log, { force: true })
        return r.first?.state === 'saved' ? 'the recording ended before it started' : failure(r.first)
      }
      const rec: Running = { pid: r.first.pid, out, log: r.log, exited: r.exited, done: false }
      void r.exited.then(() => { rec.done = true })
      current = rec
      return undefined
    }),
    async stop(): Promise<{ file: string; seconds: number } | { error: string }> {
      const rec = current
      if (!rec) return { error: 'nothing is recording' }
      current = undefined
      if (!rec.done) kill(rec.pid)
      await Promise.race([rec.exited, new Promise(r => setTimeout(r, 30_000))])
      const last = lines(rec.log).at(-1)
      rmSync(rec.log, { force: true })
      return last?.state === 'saved' ? { file: rec.out, seconds: last.seconds ?? 0 } : { error: failure(last) }
    },
  }
}
export type ScreenRecorder = ReturnType<typeof screenRecorder>
