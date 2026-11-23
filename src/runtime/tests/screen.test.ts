import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { buildApp, screenRecorder, type Launch } from '../screen.ts'

type Helper = 'records' | 'finishes' | 'deaf' | 'hangs' | string[]

function fakeHelper(helper: (job: { action: string }) => Helper, jobs: unknown[], signals: string[]) {
  const running = new Map<number, (signal: string) => void>()
  let pid = 100
  const launch: Launch = (app, log) => {
    const file = `${dirname(app)}/job.json`
    const job = JSON.parse(readFileSync(file, 'utf8'))
    jobs.push({ ...job, mode: statSync(file).mode & 0o777 })
    rmSync(file)
    const me = ++pid, kind = helper(job), say = (l: string) => appendFileSync(log, l + '\n')
    const exited = new Promise<number | null>(done => {
      if (Array.isArray(kind)) { for (const l of kind) say(l); return done(kind.some(l => l.includes('"error"')) ? 1 : 0) }
      if (kind === 'hangs') return
      say(`{"state":"recording","pid":${me}}`)
      if (kind === 'finishes') setTimeout(() => { say('{"state":"saved","seconds":5}'); done(0) }, 10)
      running.set(me, signal => {
        signals.push(signal)
        if (signal === 'SIGKILL') return done(null)
        if (kind === 'records') { say('{"state":"saved","seconds":42}'); done(0) }
      })
    })
    return { exited }
  }
  return { launch, kill: (p: number, signal: string) => running.get(p)?.(signal) }
}

describe('Kage Screen in the hub', () => {
  const setup = (helper: (job: { action: string }) => Helper = () => 'records', built: string[] = [], longSide?: number) => {
    const dir = mkdtempSync(`${tmpdir()}/kage-screen-`), jobs: Record<string, unknown>[] = [], signals: string[] = []
    const h = fakeHelper(helper, jobs, signals)
    const screen = screenRecorder({ folder: dir, code: '/code', build: async app => { built.push(app); return undefined }, launch: h.launch, kill: h.kill, pollMs: 5, waitMs: 100, ...longSide && { longSide } })
    const left = () => readdirSync(dir)
    return { dir, screen, jobs, signals, left }
  }
  test('a recording starts, keeps running, and stop hands back the saved file and its length, leaving no file behind', async () => {
    const { screen, jobs, signals, left } = setup()
    assert.equal(await screen.start('/t/a.mp4', 120), undefined)
    assert.deepEqual(jobs, [{ action: 'record', out: '/t/a.mp4', seconds: 120, mode: 0o600 }])
    assert.deepEqual(await screen.stop(), { file: '/t/a.mp4', seconds: 42 })
    assert.deepEqual(signals, ['SIGINT'])
    assert.deepEqual(left(), [])
  })
  test('only one recording runs at a time, and stop with none running says so', async () => {
    const { screen } = setup()
    assert.deepEqual(await screen.stop(), { error: 'nothing is recording' })
    await screen.start('/t/a.mp4', 60)
    assert.match(await screen.start('/t/b.mp4', 60) ?? '', /already recording/)
    await screen.stop()
    assert.equal(await screen.start('/t/c.mp4', 60), undefined)
  })
  test('a stop sent while the start is still launching stops that recording', async () => {
    const { screen } = setup()
    const [started, stopped] = await Promise.all([screen.start('/t/a.mp4', 60), screen.stop()])
    assert.equal(started, undefined)
    assert.deepEqual(stopped, { file: '/t/a.mp4', seconds: 42 })
  })
  test('two starts sent together give one recording and one refusal', async () => {
    const { screen, jobs } = setup()
    const answers = await Promise.all([screen.start('/t/a.mp4', 60), screen.start('/t/b.mp4', 60)])
    assert.deepEqual([answers[0], /already recording/.test(answers[1] ?? '')], [undefined, true])
    assert.equal(jobs.length, 1)
  })
  test('a recording that reached its time limit is saved: stop hands it back, and a new one may start', async () => {
    const { screen, signals, left } = setup(() => 'finishes')
    await screen.start('/t/a.mp4', 5)
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(await screen.stop(), { file: '/t/a.mp4', seconds: 5 })
    assert.deepEqual(signals, [])
    await screen.start('/t/b.mp4', 5)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(await screen.start('/t/c.mp4', 5), undefined)
    await screen.stop()
    assert.deepEqual(left(), [])
  })
  test('a helper that ignores SIGINT is killed after the wait, and stop says the recording was lost', async () => {
    const { screen, signals, left } = setup(() => 'deaf')
    await screen.start('/t/a.mp4', 60)
    assert.match((await screen.stop() as { error: string }).error, /did not stop/)
    assert.deepEqual(signals, ['SIGINT', 'SIGKILL'])
    assert.deepEqual(left(), [])
  })
  test('a helper that never answers does not hold up the next call', async () => {
    let first = true
    const { screen } = setup(() => first ? (first = false, 'hangs') : ['{"state":"saved","width":1280,"height":800,"pointsWide":1440,"pointsHigh":900}'])
    assert.match(String(await screen.shot('/t/s.png')), /did not answer/)
    assert.deepEqual(await screen.shot('/t/s2.png'), { width: 1280, height: 800, pointsWide: 1440, pointsHigh: 900 })
  })
  test('a recording that ended before it started is not left as running', async () => {
    const { screen } = setup(() => ['{"state":"saved","seconds":0}'])
    assert.match(await screen.start('/t/a.mp4', 5) ?? '', /ended before it started/)
    assert.deepEqual(await screen.stop(), { error: 'nothing is recording' })
  })
  test('a picture names only the app asked for and the long side, comes back with its size, and leaves no file behind (#508)', async () => {
    const { screen, jobs, left } = setup(() => ['{"state":"saved","width":1280,"height":800,"pointsWide":1440,"pointsHigh":900}'], [], 1280)
    assert.deepEqual(await screen.shot('/t/s.png', 'Google Chrome'), { width: 1280, height: 800, pointsWide: 1440, pointsHigh: 900 })
    assert.deepEqual(jobs, [{ action: 'shot', out: '/t/s.png', app: 'Google Chrome', longSide: 1280, mode: 0o600 }])
    assert.deepEqual(left(), [])
  })
  test('a picture saved with no size, from an older build, is an error, so no click is mapped from a guess (#508)', async () => {
    const { screen } = setup(() => ['{"state":"saved"}'])
    assert.match(String(await screen.shot('/t/s.png')), /not its size/)
  })
  test('with no screen permission yet, the answer tells the owner where to turn it on', async () => {
    const { screen } = setup(() => ['{"error":"permission"}'])
    assert.match(String(await screen.shot('/t/s.png')), /turn on Kage in System Settings > Privacy & Security > Screen & System Audio Recording/)
    assert.match(await screen.start('/t/a.mp4', 60) ?? '', /System Settings/)
  })
  test("the helper's own error comes back as it said it", async () => {
    const { screen } = setup(() => ['{"error":"no running app named Nope"}'])
    assert.equal(await screen.shot('/t/s.png', 'Nope'), 'Kage Screen: no running app named Nope')
  })
  test('the app is built inside the screen folder before each launch', async () => {
    const built: string[] = []
    const { dir, screen } = setup(() => ['{"state":"saved","width":1280,"height":800,"pointsWide":1440,"pointsHigh":900}'], built)
    await screen.shot('/t/s.png')
    assert.deepEqual(built, [`${dir}/Kage.app`])
  })

})

const canBuild = process.platform === 'darwin' && (() => { try { execFileSync('which', ['swiftc']); return true } catch { return false } })()
describe('building Kage Screen', { skip: !canBuild && 'needs macOS with swiftc' }, () => {
  test("a rebuild keeps the signature macOS ties its grant to, so only a new signing identity resets the grant", async () => {
    const code = mkdtempSync(`${tmpdir()}/kage-sign-code-`), folder = mkdtempSync(`${tmpdir()}/kage-sign-app-`), app = `${folder}/Kage.app`
    mkdirSync(`${folder}/Kage Screen.app/Contents`, { recursive: true })
    mkdirSync(`${code}/screen`); mkdirSync(`${code}/docs/brand`, { recursive: true })
    copyFileSync(`${import.meta.dirname}/../../../docs/brand/icon-dark.png`, `${code}/docs/brand/icon-dark.png`)
    writeFileSync(`${code}/screen/Info.plist`, readFileSync(`${import.meta.dirname}/../../../screen/Info.plist`, 'utf8').replace('dev.kage.screen<', 'dev.kage.screentest<'))
    const resets: string[] = []
    const exec = async (cmd: string, args: string[], opts: object) => {
      if (cmd === 'tccutil') { resets.push(args.join(' ')); return { stdout: '', stderr: '' } }
      return promisify(execFile)(cmd, args, opts)
    }
    const requirement = () => execFileSync('codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(`${code}/screen/KageScreen.swift`, 'print("one")\n')
    assert.equal(await buildApp(code, app, exec), undefined)
    const first = requirement()
    assert.deepEqual(resets, ['reset ScreenCapture dev.kage.screentest', 'reset Accessibility dev.kage.screentest'])
    writeFileSync(`${code}/screen/KageScreen.swift`, 'print("two")\n')
    assert.equal(await buildApp(code, app, exec), undefined)
    assert.match(first, /identifier "dev\.kage\.screentest" and certificate leaf = H"[0-9a-f]{40}"/)
    assert.equal(requirement(), first)
    assert.equal(resets.length, 2, 'the second build kept the identity, so it reset nothing')
    assert.ok(!existsSync(`${folder}/Kage Screen.app`), 'the app from before the rename is gone, so System Settings lists one Kage')
    assert.match(execFileSync('defaults', ['read', `${app}/Contents/Info`, 'CFBundleDisplayName'], { encoding: 'utf8' }), /^Kage\n$/)
  })
  test('a certificate setup that fails halfway leaves nothing behind, so the next build makes a new one', async () => {
    const code = mkdtempSync(`${tmpdir()}/kage-sign-code-`), folder = mkdtempSync(`${tmpdir()}/kage-sign-app-`), app = `${folder}/Kage.app`
    mkdirSync(`${code}/screen`); mkdirSync(`${code}/docs/brand`, { recursive: true })
    copyFileSync(`${import.meta.dirname}/../../../docs/brand/icon-dark.png`, `${code}/docs/brand/icon-dark.png`)
    writeFileSync(`${code}/screen/Info.plist`, readFileSync(`${import.meta.dirname}/../../../screen/Info.plist`, 'utf8').replace('dev.kage.screen<', 'dev.kage.screentest<'))
    writeFileSync(`${code}/screen/KageScreen.swift`, 'print("one")\n')
    const exec = async (cmd: string, args: string[], opts: object) => {
      if (cmd === 'tccutil') return { stdout: '', stderr: '' }
      if (cmd === 'security' && args[0] === 'import') throw new Error('import failed')
      return promisify(execFile)(cmd, args, opts)
    }
    assert.match(await buildApp(code, app, exec) ?? '', /could not build/)
    assert.deepEqual(readdirSync(folder).filter(f => f.startsWith('signing')), [])
  })
})

describe('Kage acting on the Mac, from the hub', () => {
  function actingHelper(o: { accessibility?: false; quitsOnFirst?: boolean } = {}) {
    const launches: Record<string, unknown>[] = [], seen: Record<string, unknown>[] = []
    let quit: (() => void) | undefined
    const launch: Launch = (app, log) => {
      const file = `${dirname(app)}/job.json`
      const job = JSON.parse(readFileSync(file, 'utf8'))
      launches.push({ ...job, mode: statSync(file).mode & 0o777 })
      rmSync(file)
      const say = (l: object) => appendFileSync(log, JSON.stringify(l) + '\n')
      const exited = new Promise<number | null>(done => {
        if (o.accessibility === false) { say({ error: 'accessibility' }); return done(3) }
        say({ state: 'acting', pid: 500 + launches.length, scale: 2 })
        const lines = createInterface({ input: createReadStream(job.fifo) })
        quit = () => { lines.close(); say({ state: 'stopped' }); done(0) }
        lines.on('line', l => { const c = JSON.parse(l); seen.push(c); if (o.quitsOnFirst && launches.length === 1) { lines.close(); say({ state: 'stopped' }); return done(0) } say(c.op === 'under' ? { id: c.id, app: 'Finder', role: 'AXButton', label: 'Open' } : { id: c.id, done: true }) })
        lines.on('close', () => done(0))
      })
      return { exited }
    }
    return { launch, launches, seen, idle: () => quit?.() }
  }
  const setup = (o: { accessibility?: false; quitsOnFirst?: boolean } = {}) => {
    const dir = mkdtempSync(`${tmpdir()}/kage-act-`), h = actingHelper(o)
    const screen = screenRecorder({ folder: dir, code: '/code', build: async () => undefined, launch: h.launch, kill: () => {}, pollMs: 5, waitMs: 2000 })
    return { dir, screen, ...h }
  }

  test('one app stays open for every act, and each answer comes back by its id', async () => {
    const t = setup()
    assert.deepEqual(await t.screen.act({ op: 'under', x: 10, y: 20 }), { app: 'Finder', role: 'AXButton', label: 'Open' })
    assert.deepEqual(await t.screen.act({ op: 'click', x: 10, y: 20, button: 'left', count: 1 }), { done: true })
    assert.equal(t.launches.length, 1)
    assert.deepEqual(t.seen.map(c => c.op), ['under', 'click'])
    assert.equal(t.launches[0]!.action, 'act')
    assert.equal(t.launches[0]!.mode, 0o600)
    assert.ok(String(t.launches[0]!.fifo).startsWith(t.dir), 'the command pipe is in the screen folder, which only the hub may write')
    t.idle()
  })

  test('once the app stops for being idle, the next act opens it again', async () => {
    const t = setup()
    await t.screen.act({ op: 'move', x: 1, y: 1 })
    t.idle()
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(await t.screen.act({ op: 'move', x: 2, y: 2 }), { done: true })
    assert.equal(t.launches.length, 2)
    t.idle()
  })

  test('a command that reaches the app as it leaves for being idle is sent again to a new one, once', async () => {
    const t = setup({ quitsOnFirst: true })
    assert.deepEqual(await t.screen.act({ op: 'move', x: 1, y: 1 }), { done: true })
    assert.equal(t.launches.length, 2)
    assert.deepEqual(t.seen.map(c => c.op), ['move', 'move'])
    t.idle()
  })
  test('a command pipe that breaks while the app still runs fails that act, and the next act opens a new app', async () => {
    const dir = mkdtempSync(`${tmpdir()}/kage-act-`)
    let launches = 0
    const exits: (() => void)[] = []
    const launch: Launch = (app, log) => {
      const job = JSON.parse(readFileSync(`${dirname(app)}/job.json`, 'utf8'))
      launches++
      const say = (l: object) => appendFileSync(log, JSON.stringify(l) + '\n')
      say({ state: 'acting', pid: 600 + launches })
      const input = createReadStream(job.fifo), lines = createInterface({ input })
      lines.on('line', l => { const c = JSON.parse(l); say({ id: c.id, done: true }); if (launches === 1) input.destroy() })
      return { exited: new Promise<null>(done => exits.push(() => { input.destroy(); done(null) })) }
    }
    const screen = screenRecorder({ folder: dir, code: '/code', build: async () => undefined, launch, kill: () => {}, pollMs: 5, waitMs: 300 })
    assert.deepEqual(await screen.act({ op: 'move', x: 1, y: 1 }), { done: true })
    await new Promise(r => setTimeout(r, 30))
    await screen.act({ op: 'move', x: 2, y: 2 })
    assert.deepEqual(await screen.act({ op: 'move', x: 3, y: 3 }), { done: true })
    assert.equal(launches, 2)
    for (const exit of exits) exit()
  })
  test("with Accessibility off, the act says the owner must turn it on, and where", async () => {
    const t = setup({ accessibility: false })
    const r = await t.screen.act({ op: 'move', x: 1, y: 1 })
    assert.ok('error' in r)
    assert.match(String(r.error), /Accessibility/)
  })
})
