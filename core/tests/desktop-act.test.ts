import { test } from 'node:test'
import assert from 'node:assert/strict'
import { desktopVerdict, onScreen, parseDesktopAct, parseDesktopSteps, type DesktopAct, type Under } from '../desktop-act.ts'

const at = (label: string, o: Partial<Under> = {}): Under => ({ app: 'Finder', role: 'AXButton', label, ...o })
const click = (x = 10, y = 10): DesktopAct => ({ action: 'click', x, y, button: 'left', count: 1 })
const key = (keys: string): DesktopAct => { const a = parseDesktopAct({ action: 'key', keys }); if ('error' in a) throw new Error(a.error); return a }

test('everyday steps run with no ask: clicks in a file picker, typing, scrolling, plain keys', () => {
  for (const label of ['Open', 'Choose', 'Downloads', 'report.pdf', 'Cancel', 'Save', 'Show Options']) assert.deepEqual(desktopVerdict(click(), at(label, { app: 'Google Chrome' }), ''), { run: true }, label)
  assert.deepEqual(desktopVerdict({ action: 'type', text: 'quarterly report' }, at('Search'), ''), { run: true })
  assert.deepEqual(desktopVerdict({ action: 'scroll', x: 5, y: 5, dy: -3, dx: 0 }, at(''), ''), { run: true })
  for (const k of ['cmd+shift+g', 'tab', 'down', 'cmd+a', 'escape']) assert.deepEqual(desktopVerdict(key(k), at(''), ''), { run: true }, k)
})

test('turning the Mac off, logging out, sleeping or locking is refused outright, from the menu or a shortcut', () => {
  for (const label of ['Shut Down…', 'Restart…', 'Log Out Ryu Doe…', 'Sleep', 'Lock Screen']) {
    const v = desktopVerdict(click(), at(label, { role: 'AXMenuItem', app: 'Safari' }), '')
    assert.ok('blocked' in v, label)
  }
  assert.ok('blocked' in desktopVerdict(click(), at('Restart', { app: 'loginwindow' }), ''))
  for (const k of ['ctrl+cmd+q', 'shift+cmd+q', 'alt+shift+cmd+q', 'ctrl+cmd+power', 'ctrl+alt+cmd+eject', 'power', 'cmd+alt+eject', 'Cmd+Shift+Q'])
    assert.ok('blocked' in desktopVerdict(key(k), at(''), ''), k)
})

test("an app's own Restart button asks, it is not the Mac's", () => {
  const v = desktopVerdict(click(), at('Restart to update', { app: 'Slack' }), '')
  assert.ok('ask' in v)
})

test('erasing a disk or the whole Mac is refused outright', () => {
  for (const [label, app] of [['Erase', 'Disk Utility'], ['Erase All Content and Settings…', 'System Settings'], ['Erase Mac…', 'System Settings']] as const)
    assert.ok('blocked' in desktopVerdict(click(), at(label, { app }), ''), `${app} ${label}`)
})

test('a click that cannot be undone asks the owner once, with the label it clicks', () => {
  for (const label of ['Delete', 'Move to Trash', 'Empty Trash', 'Uninstall', 'Remove from Library', 'Discard Changes']) {
    const v = desktopVerdict(click(), at(label, { app: 'Photos' }), '')
    assert.ok('ask' in v, label)
    assert.match((v as { ask: string }).ask, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('Enter or Space on a destructive focused control or default button asks, as a click on it would', () => {
  assert.ok('ask' in desktopVerdict(key('return'), at('Delete', { role: 'AXButton', app: 'Notes' }), ''))
  assert.ok('ask' in desktopVerdict(key('space'), at('Empty Trash', { app: 'Finder' }), ''))
  assert.ok('blocked' in desktopVerdict(key('enter'), at('Shut Down', { role: 'AXButton', app: 'loginwindow' }), ''))
  assert.deepEqual(desktopVerdict(key('return'), at('Open', { app: 'Preview' }), ''), { run: true })
})

test('a command typed into a terminal is checked when Return sends it: a one-way step asks, wrecking the Mac is refused', () => {
  const term = at('', { app: 'Terminal', role: 'AXTextArea' })
  assert.deepEqual(desktopVerdict(key('return'), term, 'ls -la ~/Downloads'), { run: true })
  assert.ok('ask' in desktopVerdict(key('return'), term, 'git push --force origin main'))
  for (const line of ['sudo shutdown -h now', 'rm -rf ~', 'rm -rf /', 'sudo rm -rf / --no-preserve-root', 'diskutil eraseDisk APFS X disk2', 'reboot', 'sudo dd if=/dev/zero of=/dev/disk2'])
    assert.ok('blocked' in desktopVerdict(key('return'), { ...term, app: 'iTerm2' }, line), line)
  assert.deepEqual(desktopVerdict(key('return'), at('Message', { app: 'Messages' }), 'rm -rf ~'), { run: true })
})

test('a label dressed in look-alike letters still asks', () => {
  assert.ok('ask' in desktopVerdict(click(), at('Dеlete', { app: 'Mail' }), ''))
})

test('an act is checked where it enters: numbers on screen, a known button, text and keys bounded', () => {
  assert.deepEqual(parseDesktopAct({ action: 'click', x: 100, y: 200 }), { action: 'click', x: 100, y: 200, button: 'left', count: 1 })
  assert.deepEqual(parseDesktopAct({ action: 'click', x: 1, y: 2, button: 'right', count: 2 }), { action: 'click', x: 1, y: 2, button: 'right', count: 2 })
  assert.deepEqual(parseDesktopAct({ action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 }), { action: 'drag', x: 1, y: 2, path: [[30, 40]] })
  assert.deepEqual(parseDesktopAct({ action: 'scroll', x: 1, y: 2, dy: -3 }), { action: 'scroll', x: 1, y: 2, dy: -3, dx: 0 })
  assert.deepEqual(parseDesktopAct({ action: 'key', keys: 'Cmd+Shift+G' }), { action: 'key', keys: 'shift+cmd+g' })
  for (const bad of [{ action: 'click', x: -1, y: 2 }, { action: 'click', x: 1 }, { action: 'click', x: 1, y: 2, button: 'middle' }, { action: 'type', text: '' }, { action: 'type', text: 'x'.repeat(5001) }, { action: 'key', keys: 'cmd+banana' }, { action: 'fly' }])
    assert.ok('error' in parseDesktopAct(bad), JSON.stringify(bad))
})

test('Return in a terminal on a line Kage did not type itself (history, a paste, a click into it) asks', () => {
  const term = at('', { app: 'Ghostty', role: 'AXTextArea' })
  const v = desktopVerdict(key('return'), term, undefined)
  assert.ok('ask' in v)
  assert.match((v as { ask: string }).ask, /did not type/)
  assert.deepEqual(desktopVerdict(key('return'), at('Open', { app: 'Preview' }), undefined), { run: true })
})

test('text with a line break typed into a terminal is refused, since each break runs a line unchecked; elsewhere it types', () => {
  const v = desktopVerdict({ action: 'type', text: 'ls\nrm -rf ~' }, at('', { app: 'Terminal' }), '')
  assert.ok('blocked' in v)
  assert.match((v as { blocked: string }).blocked, /one line/)
  assert.deepEqual(desktopVerdict({ action: 'type', text: 'Dear team,\nthanks' }, at('Body', { app: 'Mail' }), ''), { run: true })
})

test('every key a shell takes as Return is checked like Return (#478 review)', () => {
  const term = at('', { app: 'Terminal' })
  for (const k of ['ctrl+m', 'ctrl+j', 'ctrl+o', 'shift+return', 'alt+enter', 'ctrl+shift+m', 'ctrl+alt+j', 'ctrl+cmd+o']) {
    assert.ok('blocked' in desktopVerdict(key(k), term, 'sudo shutdown -h now'), k)
    assert.ok('ask' in desktopVerdict(key(k), term, undefined), k)
  }
})

test("Finder's delete shortcuts ask, as a click on Move to Trash does (#478 review)", () => {
  for (const k of ['cmd+delete', 'cmd+backspace', 'alt+cmd+delete', 'shift+cmd+delete', 'alt+shift+cmd+delete']) {
    const v = desktopVerdict(key(k), at('', { app: 'Finder' }), '')
    assert.ok('ask' in v, k)
  }
  assert.deepEqual(desktopVerdict(key('delete'), at('', { app: 'Notes' }), ''), { run: true })
})

test('pmset and osascript that sleep, shut down or log out the Mac are refused in a terminal (#478 review)', () => {
  const term = at('', { app: 'Terminal' })
  for (const line of ['pmset sleepnow', 'sudo pmset restartoneshot 0', `osascript -e 'tell app "System Events" to shut down'`, `osascript -e 'tell application "loginwindow" to «event aevtrlgo»'`, `osascript -e 'tell app "System Events" to log out'`])
    assert.ok('blocked' in desktopVerdict(key('return'), term, line), line)
})

test('the backslash key is a key', () => {
  assert.deepEqual(parseDesktopAct({ action: 'key', keys: 'cmd+\\' }), { action: 'key', keys: 'cmd+\\' })
})

test('a drag can follow a path of points, so a curve is one stroke; each point is a whole number on the screen, at most 200', () => {
  assert.deepEqual(parseDesktopAct({ action: 'drag', x: 1, y: 2, path: [{ x: 5, y: 6 }, { x: 7, y: 8 }] }), { action: 'drag', x: 1, y: 2, path: [[5, 6], [7, 8]] })
  const many = Array.from({ length: 201 }, (_, i) => ({ x: i, y: i }))
  for (const bad of [{ path: [] }, { path: [{ x: -1, y: 2 }] }, { path: [{ x: 1.5, y: 2 }] }, { path: many }, { path: [{ x: 1, y: 2 }], to_x: 3, to_y: 4 }, { path: 'nope' }])
    assert.ok('error' in parseDesktopAct({ action: 'drag', x: 1, y: 2, ...bad }), JSON.stringify(bad).slice(0, 80))
})

test('a list of steps is checked whole before any runs: one bad step names its number, and the list is 1 to 100 steps', () => {
  assert.deepEqual(parseDesktopSteps([{ action: 'move', x: 1, y: 1 }, { action: 'key', keys: 'Cmd+Z' }]), [{ action: 'move', x: 1, y: 1 }, { action: 'key', keys: 'cmd+z' }])
  const bad = parseDesktopSteps([{ action: 'move', x: 1, y: 1 }, { action: 'click', x: -4, y: 1 }])
  assert.ok('error' in bad)
  assert.match((bad as { error: string }).error, /step 2/)
  for (const list of [[], Array.from({ length: 101 }, () => ({ action: 'move', x: 1, y: 1 })), 'move', [null]])
    assert.ok('error' in parseDesktopSteps(list), JSON.stringify(list).slice(0, 40))
})

test('a point on the picture maps to screen points, on a Retina and a plain display (#508)', () => {
  const retina = { width: 1280, height: 800, pointsWide: 1440, pointsHigh: 900 }
  assert.deepEqual(onScreen(click(640, 400), retina), click(720, 450))
  const plain = { width: 1280, height: 720, pointsWide: 1920, pointsHigh: 1080 }
  assert.deepEqual(onScreen({ action: 'scroll', x: 1280, y: 720, dy: -3, dx: 0 }, plain), { action: 'scroll', x: 1920, y: 1080, dy: -3, dx: 0 })
  assert.deepEqual(onScreen({ action: 'drag', x: 0, y: 0, path: [[640, 360], [100, 50]] }, plain), { action: 'drag', x: 0, y: 0, path: [[960, 540], [150, 75]] })
  assert.deepEqual(onScreen({ action: 'type', text: 'hi' }, retina), { action: 'type', text: 'hi' })
  assert.deepEqual(onScreen(click(100, 100), { width: 1000, height: 500, pointsWide: 2000, pointsHigh: 1500 }), click(200, 300))
})
