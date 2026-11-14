// fdc's voice-note chord (hotkey.ts): Right Command and Right Option held together, anywhere on this Mac. Prints
// "ready" once it listens, "down" when both keys are held, "up" when either is let go, and "denied" when macOS
// won't let it hear the keys (the terminal app running fdc needs Input Monitoring). Exits when fdc closes its stdin.
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
// The device-dependent modifier bits: the right-hand keys apart from the left.
let rightCommand: UInt64 = 0x10, rightOption: UInt64 = 0x40
var held = false
var tapPort: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let port = tapPort { CGEvent.tapEnable(tap: port, enable: true) }
  } else if type == .flagsChanged {
    let flags = event.flags.rawValue
    let both = flags & rightCommand != 0 && flags & rightOption != 0
    if both != held { held = both; print(both ? "down" : "up") }
  }
  return Unmanaged.passUnretained(event)
}

if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                   eventsOfInterest: CGEventMask(1 << CGEventType.flagsChanged.rawValue), callback: callback, userInfo: nil) else {
  print("denied")
  exit(2)
}
tapPort = port
CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0), .commonModes)
CGEvent.tapEnable(tap: port, enable: true)
DispatchQueue.global().async { while readLine() != nil {}; exit(0) }
print("ready")
CFRunLoopRun()
