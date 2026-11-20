// Kage Screen: records the owner's screen, or takes one picture of it, with ScreenCaptureKit (runtime/screen.ts).
// It runs as its own app, so macOS asks the owner once to allow "Kage Screen", and the hub and its sessions get
// no screen access of their own. It takes no arguments: its one job is job.json beside the app, which only the
// hub may write (CONFIG_NAMES in runtime/path-guards.ts), and it deletes that file before it starts.
// Every line it prints is one JSON object. A recording stops on SIGINT, SIGTERM or the job's seconds.
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Job: Decodable { let action: String; let out: String; let seconds: Double?; let app: String? }

func emit(_ d: [String: Any]) {
  var data = try! JSONSerialization.data(withJSONObject: d)
  data.append(0x0a)
  FileHandle.standardOutput.write(data)
}
func fail(_ why: String, _ code: Int32 = 1) -> Never { emit(["error": why]); exit(code) }

final class Recording: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
  let stream: SCStream, started = Date()
  var stopping = false
  init(_ stream: SCStream) { self.stream = stream }
  func stop() {
    if stopping { return }
    stopping = true
    Task { try? await stream.stopCapture() }
  }
  func recordingOutputDidFinishRecording(_ r: SCRecordingOutput) {
    emit(["state": "saved", "seconds": Int(Date().timeIntervalSince(started).rounded())]); exit(0)
  }
  func recordingOutput(_ r: SCRecordingOutput, didFailWithError e: Error) { fail("recording failed: \(e.localizedDescription)") }
  func stream(_ s: SCStream, didStopWithError e: Error) { if !stopping { fail("the screen stream stopped: \(e.localizedDescription)") } }
}

var recording: Recording?
var signals: [DispatchSourceSignal] = []

func run() async {
  let jobURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("job.json")
  guard let raw = try? Data(contentsOf: jobURL), let job = try? JSONDecoder().decode(Job.self, from: raw) else { fail("no job") }
  try? FileManager.default.removeItem(at: jobURL)
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess(); fail("permission", 2) }

  let content: SCShareableContent
  do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) } catch { fail("permission", 2) }
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
  let out = URL(fileURLWithPath: job.out)

  if job.action == "shot" {
    do {
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(job.out)") }
      CGImageDestinationAddImage(dest, image, nil)
      if !CGImageDestinationFinalize(dest) { fail("cannot write \(job.out)") }
      emit(["state": "saved"]); exit(0)
    } catch { fail("screenshot failed: \(error.localizedDescription)") }
  }
  guard job.action == "record" else { fail("unknown action \(job.action)") }
  config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
  let stream = SCStream(filter: filter, configuration: config, delegate: nil)
  let rec = Recording(stream)
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

// ScreenCaptureKit draws its menu bar indicator with AppKit, so the main thread runs a real app loop.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { await run() }
app.run()
