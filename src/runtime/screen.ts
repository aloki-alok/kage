import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
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

type Options = { folder: string; code: string; longSide?: number; build?: (app: string) => Promise<string | undefined>; launch?: Launch; kill?: (pid: number, signal: NodeJS.Signals) => void; pollMs?: number; waitMs?: number }
type Job = { action: 'record' | 'shot'; out: string; seconds?: number; app?: string; longSide?: number } | { action: 'act'; fifo: string }
type Rec = {
  o: Options; app: string; build: (app: string) => Promise<string | undefined>; launch: Launch; kill: (pid: number, signal: NodeJS.Signals) => void
  pollMs: number; waitMs: number; current?: Running; acting?: Acting; busy: Promise<void>
}
const NO_ANSWER = 'Kage Screen did not answer in time. Try again.'

const OWNED = /^(?:act|out)-(?:p(\d+)-)?[\w-]+\.(?:fifo|log)$/
const ownerAlive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function removeOrphans(folder: string) {
  let names: string[] = []
  try { names = readdirSync(folder) } catch { return }
  for (const name of names) {
    const owned = OWNED.exec(name)
    if (owned && !(owned[1] && ownerAlive(Number(owned[1])))) rmSync(`${folder}/${name}`, { force: true })
  }
}

export function screenRecorder(o: Options) {
  const app = `${o.folder}/Kage.app`
  removeOrphans(o.folder)
  const r: Rec = {
    o, app, build: o.build ?? (a => buildApp(o.code, a)), launch: o.launch ?? openApp, kill: o.kill ?? ((pid, signal) => { try { process.kill(pid, signal) } catch {} }),
    pollMs: o.pollMs ?? 100, waitMs: o.waitMs ?? 30_000, busy: Promise.resolve(),
  }
  return {
    act: (command: { op: string } & Record<string, unknown>) => serial(r, () => act(r, command)),
    shot: (out: string, appName?: string) => serial(r, () => shot(r, out, appName)),
    start: (out: string, seconds: number, appName?: string) => serial(r, () => start(r, out, seconds, appName)),
    stop: () => serial(r, () => stop(r)),
  }
}
export type ScreenRecorder = ReturnType<typeof screenRecorder>

const lines = (log: string): Line[] => {
  let text = ''
  try { text = readFileSync(log, 'utf8') } catch { return [] }
  return text.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v as Line] : [] } catch { return [] } })
}
const failure = (l: Line | undefined) => l?.error === 'permission' ? PERMISSION : l?.error === 'accessibility' ? ACCESSIBILITY : `Kage Screen: ${l?.error ?? 'it stopped and said nothing'}`
const exitsWithin = async (exited: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined
  const ended = await Promise.race([exited.then(() => true), new Promise<false>(res => { timer = setTimeout(() => res(false), ms) })])
  clearTimeout(timer)
  return ended
}
const serial = <T>(r: Rec, f: () => Promise<T>): Promise<T> => { const p = r.busy.then(f); r.busy = p.then(() => {}, () => {}); return p }

async function launchJob(r: Rec, job: Job) {
  const { o } = r
  const err = await r.build(r.app)
  if (err) return { err }
  mkdirSync(o.folder, { recursive: true, mode: 0o700 })
  const log = `${o.folder}/out-p${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  writeFileSync(log, '', { mode: 0o600 })
  writeFileSync(`${o.folder}/job.json`, JSON.stringify(job), { mode: 0o600 })
  return { log, exited: r.launch(r.app, log).exited }
}

async function firstLine(r: Rec, log: string, exited: Promise<unknown>) {
  let ended = false
  void exited.then(() => { ended = true })
  for (let waited = 0; waited < r.waitMs; waited += r.pollMs) {
    const first = lines(log)[0]
    if (first || ended) return first ?? lines(log)[0]
    await new Promise(res => setTimeout(res, r.pollMs))
  }
  return undefined
}

async function startActing(r: Rec): Promise<Acting | string> {
  mkdirSync(r.o.folder, { recursive: true, mode: 0o700 })
  const fifo = `${r.o.folder}/act-p${process.pid}-${Date.now()}.fifo`
  try { await run('mkfifo', ['-m', '600', fifo], { timeout: 10_000 }) } catch (e) { return `could not make the command pipe: ${String(e)}` }
  const j = await launchJob(r, { action: 'act', fifo })
  if ('err' in j) { rmSync(fifo, { force: true }); return j.err! }
  const first = await firstLine(r, j.log, j.exited)
  if (first?.state !== 'acting') { rmSync(j.log, { force: true }); rmSync(fifo, { force: true }); return !first ? NO_ANSWER : failure(first) }
  const a: Acting = { log: j.log, pipe: createWriteStream(fifo), next: 0, done: false }
  a.pipe.on('error', () => { a.done = true })
  void j.exited.then(() => { a.said = lines(j.log); a.done = true; a.pipe.destroy(); rmSync(fifo, { force: true }); rmSync(j.log, { force: true }) })
  return a
}

async function send(r: Rec, command: Record<string, unknown>): Promise<ActAnswer | 'left idle'> {
  if (!r.acting || r.acting.done) { const a = await startActing(r); if (typeof a === 'string') return { error: a }; r.acting = a }
  const a = r.acting, id = ++a.next
  a.pipe.write(JSON.stringify({ ...command, id }) + '\n')
  for (let waited = 0; waited < r.waitMs; waited += r.pollMs) {
    const said = a.said ?? lines(a.log), answer = said.find(l => l.id === id)
    if (answer) { const { id: _, ...rest } = answer; return rest }
    if (a.said) return said.at(-1)?.state === 'stopped' ? 'left idle' : { error: failure(said.at(-1)) }
    await new Promise(res => setTimeout(res, r.pollMs))
  }
  return { error: NO_ANSWER }
}

async function act(r: Rec, command: { op: string } & Record<string, unknown>): Promise<ActAnswer> {
  const first = await send(r, command)
  if (first !== 'left idle') return first
  const again = await send(r, command)
  return again === 'left idle' ? { error: NO_ANSWER } : again
}

async function shot(r: Rec, out: string, appName?: string): Promise<string | Picture> {
  const j = await launchJob(r, { action: 'shot', out, ...appName && { app: appName }, ...r.o.longSide && { longSide: r.o.longSide } })
  if ('err' in j) return j.err!
  const ended = await exitsWithin(j.exited, r.waitMs)
  const last = lines(j.log).at(-1)
  rmSync(j.log, { force: true })
  if (!ended) return NO_ANSWER
  if (last?.state !== 'saved') return failure(last)
  const { width, height, pointsWide, pointsHigh } = last
  return width && height && pointsWide && pointsHigh ? { width, height, pointsWide, pointsHigh } : 'Kage Screen saved the picture but not its size: it runs an older build, so try again'
}

async function start(r: Rec, out: string, seconds: number, appName?: string): Promise<string | undefined> {
  if (r.current && !r.current.done) return 'already recording: stop that recording first'
  if (r.current) rmSync(r.current.log, { force: true })
  r.current = undefined
  const j = await launchJob(r, { action: 'record', out, seconds, ...appName && { app: appName } })
  if ('err' in j) return j.err
  const first = await firstLine(r, j.log, j.exited)
  if (first?.state !== 'recording' || !first.pid) {
    rmSync(j.log, { force: true })
    return !first ? NO_ANSWER : first.state === 'saved' ? 'the recording ended before it started' : failure(first)
  }
  const rec: Running = { pid: first.pid, out, log: j.log, exited: j.exited, done: false }
  void j.exited.then(() => { rec.done = true })
  r.current = rec
  return undefined
}

async function stop(r: Rec): Promise<{ file: string; seconds: number } | { error: string }> {
  const rec = r.current
  if (!rec) return { error: 'nothing is recording' }
  r.current = undefined
  if (!rec.done) r.kill(rec.pid, 'SIGINT')
  const ended = await exitsWithin(rec.exited, r.waitMs)
  if (!ended) r.kill(rec.pid, 'SIGKILL')
  const last = lines(rec.log).at(-1)
  rmSync(rec.log, { force: true })
  if (!ended) return { error: 'Kage Screen did not stop, so the recording was lost' }
  return last?.state === 'saved' ? { file: rec.out, seconds: last.seconds ?? 0 } : { error: failure(last) }
}
