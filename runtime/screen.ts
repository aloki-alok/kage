import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
import { release } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import type { Picture } from '../core/desktop-act.ts'

export type Launch = (app: string, log: string) => { exited: Promise<number | null> }
type Line = { state?: 'recording' | 'saved' | 'acting' | 'stopped'; pid?: number; seconds?: number; error?: string; id?: number; width?: number; height?: number; pointsWide?: number; pointsHigh?: number }
export type ActAnswer = Record<string, unknown>
type Acting = { log: string; pipe: WriteStream; next: number; done: boolean; said?: Line[] }
type Running = { pid: number; out: string; log: string; exited: Promise<number | null>; done: boolean }

const PERMISSION = "macOS needs the owner's yes first. It asked them to turn on Kage in System Settings > Privacy & Security > Screen & System Audio Recording. Tell the owner, and try again once they have."
const ACCESSIBILITY = "macOS needs the owner's yes first. It asked them to turn on Kage in System Settings > Privacy & Security > Accessibility. Tell the owner, and try again once it is on."
const run = promisify(execFile)

type Exec = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>

async function signingIdentity(dir: string, exec: Exec): Promise<string> {
  const keychain = `${dir}/signing.keychain-db`, passFile = `${dir}/signing-pass`
  if (!existsSync(keychain) || !existsSync(passFile)) {
    rmSync(keychain, { force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const pass = randomBytes(24).toString('hex'), p12 = `${dir}/signing.p12`, key = `${dir}/signing-key.pem`, cert = `${dir}/signing-cert.pem`, conf = `${dir}/signing.cnf`
    writeFileSync(passFile, pass, { mode: 0o600 })
    writeFileSync(conf, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Kage Screen\n[ext]\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nbasicConstraints=critical,CA:false\n', { mode: 0o600 })
    try {
      await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '36500', '-config', conf, '-extensions', 'ext'], { timeout: 60_000 })
      await exec('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${pass}`], { timeout: 60_000 })
      await exec('security', ['create-keychain', '-p', pass, keychain], { timeout: 30_000 })
      await exec('security', ['set-keychain-settings', keychain], { timeout: 30_000 })
      await exec('security', ['unlock-keychain', '-p', pass, keychain], { timeout: 30_000 })
      await exec('security', ['import', p12, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign'], { timeout: 30_000 })
      await exec('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', pass, keychain], { timeout: 30_000 })
    } catch (e) {
      for (const f of [keychain, passFile]) rmSync(f, { force: true })
      throw e
    } finally { for (const f of [p12, key, cert, conf]) rmSync(f, { force: true }) }
  }
  await exec('security', ['unlock-keychain', '-p', readFileSync(passFile, 'utf8'), keychain], { timeout: 30_000 })
  const id = /\) ([0-9A-F]{40}) "Kage Screen"/.exec((await exec('security', ['find-identity', keychain], { timeout: 30_000 })).stdout)?.[1]
  if (!id) throw new Error('the Kage Screen signing certificate is missing from its keychain')
  return id
}

export async function buildApp(code: string, app: string, exec: Exec = run): Promise<string | undefined> {
  if (Number(release().split('.')[0]) < 24) return 'Kage Screen needs macOS 15 or later'
  const swift = `${code}/screen/KageScreen.swift`, plist = `${code}/screen/Info.plist`, icon = `${code}/docs/brand/icon-dark.png`, stamp = `${dirname(app)}/source-hash`, signedBy = `${dirname(app)}/signed-by`
  const hash = createHash('sha256').update(readFileSync(swift)).update(readFileSync(plist)).update(readFileSync(icon)).digest('hex')
  if (existsSync(`${app}/Contents/MacOS/KageScreen`) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return undefined
  try {
    const id = await signingIdentity(dirname(app), exec)
    for (const old of [app, `${dirname(app)}/Kage Screen.app`]) rmSync(old, { recursive: true, force: true })
    mkdirSync(`${app}/Contents/MacOS`, { recursive: true, mode: 0o700 })
    await exec('swiftc', ['-O', '-o', `${app}/Contents/MacOS/KageScreen`, swift], { timeout: 300_000 })
    copyFileSync(plist, `${app}/Contents/Info.plist`)
    await makeIcon(icon, `${app}/Contents/Resources/AppIcon.icns`, `${dirname(app)}/AppIcon.iconset`)
    await exec('codesign', ['-s', id, '--keychain', `${dirname(app)}/signing.keychain-db`, '--force', app], { timeout: 60_000 })
    if (!existsSync(signedBy) || readFileSync(signedBy, 'utf8') !== id) {
      const bundle = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1] ?? 'dev.kage.screen'
      for (const service of ['ScreenCapture', 'Accessibility']) await exec('tccutil', ['reset', service, bundle], { timeout: 30_000 }).catch(() => {})
      writeFileSync(signedBy, id, { mode: 0o600 })
    }
    writeFileSync(stamp, hash, { mode: 0o600 })
    return undefined
  } catch (e) {
    return `could not build Kage Screen, which needs the Xcode Command Line Tools (xcode-select --install): ${String((e as { stderr?: string }).stderr || e).split('\n')[0]}`
  }
}

async function makeIcon(png: string, icns: string, set: string) {
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  mkdirSync(dirname(icns), { recursive: true })
  for (const size of [16, 32, 128, 256]) {
    for (const [scale, name] of [[1, `icon_${size}x${size}.png`], [2, `icon_${size}x${size}@2x.png`]] as const)
      await run('sips', ['-z', String(size * scale), String(size * scale), png, '--out', `${set}/${name}`], { timeout: 30_000 })
  }
  copyFileSync(png, `${set}/icon_512x512.png`)
  await run('iconutil', ['-c', 'icns', set, '-o', icns], { timeout: 30_000 })
  rmSync(set, { recursive: true, force: true })
}

const openApp: Launch = (app, log) => {
  const child = spawn('/usr/bin/open', ['-W', '-n', '-g', '--stdout', log, '--stderr', '/dev/null', app], { stdio: 'ignore' })
  return { exited: new Promise(done => { child.on('exit', done); child.on('error', () => done(null)) }) }
}

export function screenRecorder(o: { folder: string; code: string; longSide?: number; build?: (app: string) => Promise<string | undefined>; launch?: Launch; kill?: (pid: number, signal: NodeJS.Signals) => void; pollMs?: number; waitMs?: number }) {
  const app = `${o.folder}/Kage.app`
  const build = o.build ?? (a => buildApp(o.code, a))
  const launch = o.launch ?? openApp, kill = o.kill ?? ((pid, signal) => { try { process.kill(pid, signal) } catch {} })
  const pollMs = o.pollMs ?? 100, waitMs = o.waitMs ?? 30_000
  const NO_ANSWER = 'Kage Screen did not answer in time. Try again.'
  let current: Running | undefined
  let busy = Promise.resolve()

  const lines = (log: string): Line[] => {
    let text = ''
    try { text = readFileSync(log, 'utf8') } catch { return [] }
    return text.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v as Line] : [] } catch { return [] } })
  }
  const failure = (l: Line | undefined) => l?.error === 'permission' ? PERMISSION : l?.error === 'accessibility' ? ACCESSIBILITY : `Kage Screen: ${l?.error ?? 'it stopped and said nothing'}`
  const exitsWithin = async (exited: Promise<unknown>, ms: number) => {
    let timer: NodeJS.Timeout | undefined
    const ended = await Promise.race([exited.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), ms) })])
    clearTimeout(timer)
    return ended
  }
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = busy.then(f); busy = p.then(() => {}, () => {}); return p }

  async function launchJob(job: { action: 'record' | 'shot'; out: string; seconds?: number; app?: string; longSide?: number } | { action: 'act'; fifo: string }) {
    const err = await build(app)
    if (err) return { err }
    mkdirSync(o.folder, { recursive: true, mode: 0o700 })
    const log = `${o.folder}/out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
    writeFileSync(log, '', { mode: 0o600 })
    writeFileSync(`${o.folder}/job.json`, JSON.stringify(job), { mode: 0o600 })
    return { log, exited: launch(app, log).exited }
  }
  async function firstLine(log: string, exited: Promise<unknown>) {
    let ended = false
    void exited.then(() => { ended = true })
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      const first = lines(log)[0]
      if (first || ended) return first ?? lines(log)[0]
      await new Promise(r => setTimeout(r, pollMs))
    }
    return undefined
  }

  let acting: Acting | undefined
  async function startActing(): Promise<Acting | string> {
    mkdirSync(o.folder, { recursive: true, mode: 0o700 })
    const fifo = `${o.folder}/act-${Date.now()}.fifo`
    try { await run('mkfifo', ['-m', '600', fifo], { timeout: 10_000 }) } catch (e) { return `could not make the command pipe: ${String(e)}` }
    const r = await launchJob({ action: 'act', fifo })
    if ('err' in r) { rmSync(fifo, { force: true }); return r.err! }
    const first = await firstLine(r.log, r.exited)
    if (first?.state !== 'acting') { rmSync(r.log, { force: true }); rmSync(fifo, { force: true }); return !first ? NO_ANSWER : failure(first) }
    const a: Acting = { log: r.log, pipe: createWriteStream(fifo), next: 0, done: false }
    a.pipe.on('error', () => { a.done = true })
    void r.exited.then(() => { a.said = lines(r.log); a.done = true; a.pipe.destroy(); rmSync(fifo, { force: true }); rmSync(r.log, { force: true }) })
    return a
  }

  async function send(command: Record<string, unknown>): Promise<ActAnswer | 'left idle'> {
    if (!acting || acting.done) { const a = await startActing(); if (typeof a === 'string') return { error: a }; acting = a }
    const a = acting, id = ++a.next
    a.pipe.write(JSON.stringify({ ...command, id }) + '\n')
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      const said = a.said ?? lines(a.log), answer = said.find(l => l.id === id)
      if (answer) { const { id: _, ...rest } = answer; return rest }
      if (a.said) return said.at(-1)?.state === 'stopped' ? 'left idle' : { error: failure(said.at(-1)) }
      await new Promise(r => setTimeout(r, pollMs))
    }
    return { error: NO_ANSWER }
  }

  return {
    act: (command: { op: string } & Record<string, unknown>) => serial(async (): Promise<ActAnswer> => {
      const first = await send(command)
      if (first !== 'left idle') return first
      const again = await send(command)
      return again === 'left idle' ? { error: NO_ANSWER } : again
    }),
    shot: (out: string, appName?: string) => serial(async (): Promise<string | Picture> => {
      const r = await launchJob({ action: 'shot', out, ...appName && { app: appName }, ...o.longSide && { longSide: o.longSide } })
      if ('err' in r) return r.err!
      const ended = await exitsWithin(r.exited, waitMs)
      const last = lines(r.log).at(-1)
      rmSync(r.log, { force: true })
      if (!ended) return NO_ANSWER
      if (last?.state !== 'saved') return failure(last)
      const { width, height, pointsWide, pointsHigh } = last
      return width && height && pointsWide && pointsHigh ? { width, height, pointsWide, pointsHigh } : 'Kage Screen saved the picture but not its size: it runs an older build, so try again'
    }),
    start: (out: string, seconds: number, appName?: string) => serial(async (): Promise<string | undefined> => {
      if (current && !current.done) return 'already recording: stop that recording first'
      if (current) rmSync(current.log, { force: true })
      current = undefined
      const r = await launchJob({ action: 'record', out, seconds, ...appName && { app: appName } })
      if ('err' in r) return r.err
      const first = await firstLine(r.log, r.exited)
      if (first?.state !== 'recording' || !first.pid) {
        rmSync(r.log, { force: true })
        return !first ? NO_ANSWER : first.state === 'saved' ? 'the recording ended before it started' : failure(first)
      }
      const rec: Running = { pid: first.pid, out, log: r.log, exited: r.exited, done: false }
      void r.exited.then(() => { rec.done = true })
      current = rec
      return undefined
    }),
    stop: () => serial(async (): Promise<{ file: string; seconds: number } | { error: string }> => {
      const rec = current
      if (!rec) return { error: 'nothing is recording' }
      current = undefined
      if (!rec.done) kill(rec.pid, 'SIGINT')
      const ended = await exitsWithin(rec.exited, waitMs)
      if (!ended) kill(rec.pid, 'SIGKILL')
      const last = lines(rec.log).at(-1)
      rmSync(rec.log, { force: true })
      if (!ended) return { error: 'Kage Screen did not stop, so the recording was lost' }
      return last?.state === 'saved' ? { file: rec.out, seconds: last.seconds ?? 0 } : { error: failure(last) }
    }),
  }
}
export type ScreenRecorder = ReturnType<typeof screenRecorder>
