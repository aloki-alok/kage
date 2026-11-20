import { test } from 'node:test'
import assert from 'node:assert/strict'
import { desktopVerdict, parseDesktopAct, type DesktopAct, type Under } from '../desktop-act.ts'

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
  assert.deepEqual(parseDesktopAct({ action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 }), { action: 'drag', x: 1, y: 2, toX: 30, toY: 40 })
  assert.deepEqual(parseDesktopAct({ action: 'scroll', x: 1, y: 2, dy: -3 }), { action: 'scroll', x: 1, y: 2, dy: -3, dx: 0 })
  assert.deepEqual(parseDesktopAct({ action: 'key', keys: 'Cmd+Shift+G' }), { action: 'key', keys: 'shift+cmd+g' })
  for (const bad of [{ action: 'click', x: -1, y: 2 }, { action: 'click', x: 1 }, { action: 'click', x: 1, y: 2, button: 'middle' }, { action: 'type', text: '' }, { action: 'type', text: 'x'.repeat(5001) }, { action: 'key', keys: 'cmd+banana' }, { action: 'fly' }])
    assert.ok('error' in parseDesktopAct(bad), JSON.stringify(bad))
})
