// Kage Screen: records the owner's screen, or takes one picture of it, with ScreenCaptureKit (runtime/screen.ts).
// It runs as its own app, so macOS asks the owner once to allow "Kage Screen", and the hub and its sessions get
// no screen access of their own. It takes no arguments: its one job is job.json beside the app, which only the
// hub may write (CONFIG_NAMES in runtime/path-guards.ts), and it deletes that file before it starts.
// Every line it prints is one JSON object. A recording stops on SIGINT, SIGTERM or the job's seconds.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import QuartzCore
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Job: Decodable { let action: String; let out: String?; let seconds: Double?; let app: String?; let fifo: String? }

func emit(_ d: [String: Any]) {
  var data = try! JSONSerialization.data(withJSONObject: d)
  data.append(0x0a)
  FileHandle.standardOutput.write(data)
}
func fail(_ why: String, _ code: Int32 = 1) -> Never { emit(["error": why]); exit(code) }

final class Recording: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
  var stream: SCStream?
  let started = Date()
  var stopping = false
  // Saving ends with recordingOutputDidFinishRecording. If it never comes, exit so the hub is not left waiting.
  func stop() {
    if stopping { return }
    stopping = true
    Task { try? await stream?.stopCapture() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { fail("the recording did not finish saving") }
  }
  func recordingOutputDidFinishRecording(_ r: SCRecordingOutput) {
    emit(["state": "saved", "seconds": Int(Date().timeIntervalSince(started).rounded())]); exit(0)
  }
  func recordingOutput(_ r: SCRecordingOutput, didFailWithError e: Error) { fail("recording failed: \(e.localizedDescription)") }
  // The owner stopped it from the menu bar, or the display went away: save what was recorded.
  func stream(_ s: SCStream, didStopWithError e: Error) { stop() }
}

var recording: Recording?
var signals: [DispatchSourceSignal] = []

func run() async {
  let jobURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("job.json")
  guard let raw = try? Data(contentsOf: jobURL), let job = try? JSONDecoder().decode(Job.self, from: raw) else { fail("no job") }
  try? FileManager.default.removeItem(at: jobURL)
  if job.action == "act" { startActing(job); return }
  guard let outPath = job.out else { fail("no out file") }
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess(); fail("permission", 2) }

  let content: SCShareableContent
  do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) } catch { fail("could not read the screen: \(error.localizedDescription)") }
  guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { fail("no display") }
  let filter: SCContentFilter
  if let name = job.app {
    let n = name.lowercased()
    guard let app = content.applications.first(where: { $0.applicationName.lowercased() == n || $0.bundleIdentifier.lowercased() == n }) else { fail("no running app named \(name)") }
    filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
  } else {
    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
  }
  let config = SCStreamConfiguration()
  let px = CGSize(width: filter.contentRect.width * CGFloat(filter.pointPixelScale), height: filter.contentRect.height * CGFloat(filter.pointPixelScale))
  // A video fits in 1920 by 1080: full Retina size is about 19 Mbit/s, too big to send. A picture keeps every pixel.
  let fit = job.action == "record" ? min(1, 1920 / px.width, 1080 / px.height) : 1
  config.width = Int(px.width * fit) / 2 * 2
  config.height = Int(px.height * fit) / 2 * 2
  config.showsCursor = true
  let out = URL(fileURLWithPath: outPath)

  if job.action == "shot" {
    do {
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(outPath)") }
      CGImageDestinationAddImage(dest, image, nil)
      if !CGImageDestinationFinalize(dest) { fail("cannot write \(outPath)") }
      emit(["state": "saved"]); exit(0)
    } catch { fail("screenshot failed: \(error.localizedDescription)") }
  }
  guard job.action == "record" else { fail("unknown action \(job.action)") }
  config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
  let rec = Recording()
  let stream = SCStream(filter: filter, configuration: config, delegate: rec)
  rec.stream = stream
  let recConfig = SCRecordingOutputConfiguration()
  recConfig.outputURL = out
  recConfig.outputFileType = .mp4
  recConfig.videoCodecType = .h264
  do {
    try stream.addRecordingOutput(SCRecordingOutput(configuration: recConfig, delegate: rec))
    try await stream.startCapture()
  } catch { fail("could not start recording: \(error.localizedDescription)") }
  recording = rec
  for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler { recording?.stop() }
    s.resume()
    signals.append(s)
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + min(job.seconds ?? 300, 600)) { recording?.stop() }
  emit(["state": "recording", "pid": Int(getpid())])
}

// Acting on the Mac: the hub writes one JSON command per line into a FIFO only it may write (the job's fifo),
// and every answer is one JSON line with the command's id. Kage's own cursor glides to each point first, so the
// owner sees where it acts. macOS asks once for Accessibility, which posting input and reading controls need.
// The hub decides what may run (core/desktop-act.ts); this app only refuses keys it has no code for.
struct Command: Decodable {
  let id: Int; let op: String
  let x: Double?; let y: Double?; let path: [[Double]]?
  let button: String?; let count: Int?; let dy: Int?; let dx: Int?; let text: String?; let keys: String?
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "enter": 76, "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
]
let modifierFlags: [String: CGEventFlags] = ["ctrl": .maskControl, "alt": .maskAlternate, "shift": .maskShift, "cmd": .maskCommand]

final class CursorView: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let tip = NSPoint(x: 4, y: bounds.height - 4)
    let arrow = NSBezierPath()
    arrow.move(to: tip)
    arrow.line(to: NSPoint(x: tip.x, y: tip.y - 26))
    arrow.line(to: NSPoint(x: tip.x + 7, y: tip.y - 20))
    arrow.line(to: NSPoint(x: tip.x + 12, y: tip.y - 30))
    arrow.line(to: NSPoint(x: tip.x + 16, y: tip.y - 28))
    arrow.line(to: NSPoint(x: tip.x + 11, y: tip.y - 18))
    arrow.line(to: NSPoint(x: tip.x + 20, y: tip.y - 18))
    arrow.close()
    NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.1, alpha: 1).setFill()
    arrow.fill()
    NSColor.white.setStroke()
    arrow.lineWidth = 1.5
    arrow.stroke()
    let tag = NSAttributedString(string: "Kage", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.white])
    let box = NSRect(x: tip.x + 14, y: tip.y - 44, width: tag.size().width + 10, height: 16)
    NSColor(calibratedRed: 0.8, green: 0.3, blue: 0.2, alpha: 0.95).setFill()
    NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
    tag.draw(at: NSPoint(x: box.minX + 5, y: box.minY + 2))
  }
}

final class Hands {
  let window: NSWindow
  let scale: CGFloat
  var lastCommand = Date()
  init() {
    let main = CGMainDisplayID()
    let mode = CGDisplayCopyDisplayMode(main)
    scale = CGFloat(mode?.pixelWidth ?? 2) / CGFloat(max(1, mode?.width ?? 1))
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 80, height: 56), styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    window.contentView = CursorView(frame: window.contentRect(forFrameRect: window.frame))
    window.contentView?.wantsLayer = true
    let now = CGEvent(source: nil)?.location ?? .zero
    place(at: now, animated: false)
    window.orderFrontRegardless()
  }
  // Points from the screen picture's pixels; CG puts the origin top left, AppKit bottom left.
  func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x / Double(scale), y: y / Double(scale)) }
  func place(at p: CGPoint, animated: Bool) {
    let height = NSScreen.screens.first?.frame.height ?? 0
    let origin = NSPoint(x: p.x - 4, y: height - p.y - window.frame.height + 4)
    if !animated { window.setFrameOrigin(origin); return }
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.18
      ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      window.animator().setFrameOrigin(origin)
    }
  }
  func glide(to p: CGPoint) {
    DispatchQueue.main.sync { place(at: p, animated: true) }
    usleep(190_000)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    // Web views (ExcalidrawZ, Electron apps) drop a click that lands with the move that brought the mouse there.
    usleep(60_000)
  }
  func pulse() {
    DispatchQueue.main.async {
      guard let layer = self.window.contentView?.layer else { return }
      let a = CABasicAnimation(keyPath: "opacity")
      a.fromValue = 0.35
      a.toValue = 1
      a.duration = 0.25
      layer.add(a, forKey: "pulse")
    }
  }
  func click(_ p: CGPoint, right: Bool, count: Int) {
    glide(to: p)
    let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    for n in 1...max(1, count) {
      for type in [down, up] {
        let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        e?.post(tap: .cghidEventTap)
        usleep(12_000)
      }
    }
    pulse()
  }
  // One stroke through every point of the path, a dragged event about every 8 points, so a curve stays smooth.
  func drag(_ from: CGPoint, through path: [CGPoint]) {
    glide(to: from)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    var last = from
    for to in path {
      let steps = max(1, Int((hypot(to.x - last.x, to.y - last.y) / 8).rounded(.up)))
      for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: last.x + (to.x - last.x) * t, y: last.y + (to.y - last.y) * t)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        DispatchQueue.main.sync { place(at: p, animated: false) }
        usleep(8_000)
      }
      last = to
    }
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left)?.post(tap: .cghidEventTap)
  }
  func scroll(_ p: CGPoint, dy: Int, dx: Int) {
    glide(to: p)
    CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?.post(tap: .cghidEventTap)
  }
  func type(_ text: String) {
    let characters = Array(text)
    for start in stride(from: 0, to: characters.count, by: 8) {
      var chunk = Array(String(characters[start..<min(start + 8, characters.count)]).utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        e?.post(tap: .cghidEventTap)
      }
      usleep(8_000)
    }
  }
  func key(_ combo: String) -> String? {
    let parts = combo.split(separator: "+").map(String.init)
    guard let last = parts.last, let code = keyCodes[last] else { return "no key named \(combo)" }
    var flags: CGEventFlags = []
    for m in parts.dropLast() { guard let f = modifierFlags[m] else { return "no modifier named \(m)" }; flags.insert(f) }
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
      e?.flags = flags
      e?.post(tap: .cghidEventTap)
    }
    return nil
  }
  func describe(_ el: AXUIElement?) -> [String: Any] {
    var app = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    guard let el else { return ["app": app, "role": "", "label": ""] }
    func attr(_ name: String) -> String? {
      var v: CFTypeRef?
      guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
      return v as? String
    }
    var pid: pid_t = 0
    if AXUIElementGetPid(el, &pid) == .success, let owner = NSRunningApplication(processIdentifier: pid)?.localizedName { app = owner }
    let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute].lazy.compactMap { attr($0 as String) }.first { !$0.isEmpty } ?? ""
    return ["app": app, "role": attr(kAXRoleAttribute as String) ?? "", "label": String(label.prefix(200))]
  }
  // The hit is often an icon or text inside a button, with no label of its own: read up to the control that has one.
  func under(_ p: CGPoint) -> [String: Any] {
    var el: AXUIElement?
    AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el)
    var seen = describe(el)
    for _ in 0..<4 where (seen["label"] as? String ?? "").isEmpty {
      var parent: CFTypeRef?
      guard let child = el, AXUIElementCopyAttributeValue(child, kAXParentAttribute as CFString, &parent) == .success, let up = parent else { break }
      el = (up as! AXUIElement)
      seen = describe(el)
    }
    return seen
  }
  // Enter or Space presses the focused control, or a dialog's default button when no control takes it.
  func focused() -> [String: Any] {
    let system = AXUIElementCreateSystemWide()
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &v) == .success, let raw = v else { return describe(nil) }
    let el = raw as! AXUIElement
    let seen = describe(el)
    if (seen["role"] as? String) == (kAXButtonRole as String) { return seen }
    var win: CFTypeRef?, button: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &win) == .success, let w = win,
       AXUIElementCopyAttributeValue(w as! AXUIElement, kAXDefaultButtonAttribute as CFString, &button) == .success, let b = button {
      var d = describe(b as! AXUIElement)
      d["role"] = kAXButtonRole as String
      return d
    }
    return seen
  }
  func run(_ c: Command) -> [String: Any] {
    lastCommand = Date()
    defer { lastCommand = Date() }
    DispatchQueue.main.sync { window.alphaValue = 1 }
    let p = c.x.map { point($0, c.y ?? 0) }
    switch c.op {
    case "under": guard let p else { return ["error": "under needs x and y"] }; return under(p)
    case "focused": return focused()
    case "click": guard let p else { return ["error": "click needs x and y"] }; click(p, right: c.button == "right", count: c.count ?? 1); return ["done": true]
    case "move": guard let p else { return ["error": "move needs x and y"] }; glide(to: p); return ["done": true]
    case "drag":
      let path = (c.path ?? []).compactMap { $0.count == 2 ? point($0[0], $0[1]) : nil }
      guard let p, !path.isEmpty, path.count == c.path?.count else { return ["error": "drag needs x, y and a path of points"] }
      drag(p, through: path); return ["done": true]
    case "scroll": guard let p else { return ["error": "scroll needs x and y"] }; scroll(p, dy: c.dy ?? 0, dx: c.dx ?? 0); return ["done": true]
    case "type": type(c.text ?? ""); return ["done": true]
    case "key": if let why = key(c.keys ?? "") { return ["error": why] }; return ["done": true]
    default: return ["error": "unknown command \(c.op)"]
    }
  }
}

var hands: Hands?
let work = DispatchQueue(label: "dev.kage.screen.act")

// run() is on a background task, and windows and timers belong to the main thread.
func startActing(_ job: Job) { DispatchQueue.main.async { startActingOnMain(job) } }

func startActingOnMain(_ job: Job) {
  guard let fifo = job.fifo else { fail("no fifo") }
  if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) { fail("accessibility", 3) }
  let a = Hands()
  hands = a
  emit(["state": "acting", "pid": Int(getpid()), "scale": Double(a.scale)])
  Thread.detachNewThread {
    guard let input = FileHandle(forReadingAtPath: fifo) else { fail("cannot read \(fifo)") }
    var buffer = Data()
    while true {
      let chunk = input.availableData
      if chunk.isEmpty { emit(["state": "stopped"]); exit(0) }
      buffer.append(chunk)
      while let nl = buffer.firstIndex(of: 0x0a) {
        let line = buffer[buffer.startIndex..<nl]
        buffer.removeSubrange(buffer.startIndex...nl)
        struct Numbered: Decodable { let id: Int }
        guard let c = try? JSONDecoder().decode(Command.self, from: line) else {
          if let n = try? JSONDecoder().decode(Numbered.self, from: line) { emit(["id": n.id, "error": "bad command"]) } else { emit(["error": "bad command"]) }
          continue
        }
        work.sync {
          var answer = a.run(c)
          answer["id"] = c.id
          emit(answer)
        }
      }
    }
  }
  // Idle 4 seconds: Kage's cursor fades so it never sits on the owner's screen, and the next step brings it back.
  // Idle 5 minutes: the work is done and the app leaves. The check runs on the queue that runs steps, so the app
  // never leaves or fades mid-step, and the hub may resend a step it got no answer to.
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    work.async {
      let idle = Date().timeIntervalSince(a.lastCommand)
      if idle > 300 { emit(["state": "stopped"]); exit(0) }
      if idle > 4 { DispatchQueue.main.async { if a.window.alphaValue == 1 { NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.4; a.window.animator().alphaValue = 0 } } } }
    }
  }
}

// ScreenCaptureKit draws its menu bar indicator with AppKit, so the main thread runs a real app loop.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// A picture, or the start of a recording, that hangs (a macOS prompt, a stuck capture) ends here, not never.
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { if recording == nil && hands == nil { fail("timed out") } }
Task { await run() }
app.run()
