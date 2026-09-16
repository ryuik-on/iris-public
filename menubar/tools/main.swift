import AppKit

/*
 * 画面を開かずに、帯の絵を PNG にする。
 *
 * 実機の撮影は画面が消えていると取れず、開いている窓を探して切り出す手も
 * Space やアプリの前後で外れる。**描いているコードそのもの**を呼んで画像に
 * するほうが速く、確かめたい対象にも近い。ここが出す絵は `Day` の窓の中身と
 * 同じ `DayBandView`。窓の枠と見出しは含まない。
 *
 *   swiftc -O -o /tmp/render-day IrisMenuBar.swift Hotkeys.swift Ask.swift \
 *     Travel.swift Rail.swift Shape.swift Schedule.swift Day.swift tools/render-day.swift
 *   /tmp/render-day out.png
 */
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "day.png"

let events = [
    CalendarEvent(title: "病理学Ⅱ31-32", start: "2026-09-09T08:30", end: "2026-09-09T10:40", allDay: false),
    CalendarEvent(title: "病理学Ⅱ33-34", start: "2026-09-09T12:50", end: "2026-09-09T15:00", allDay: false),
    CalendarEvent(title: "AI爆速アプリ フィードバック", start: "2026-09-09T19:00", end: "2026-09-09T20:00", allDay: false),
]
let slots = [
    DaySlot(from: "10:40", to: "12:50"),
    DaySlot(from: "15:00", to: "19:00"),
    DaySlot(from: "20:00", to: "24:00"),
]

let size = NSSize(width: 392, height: 452)
let view = DayBandView(frame: NSRect(origin: .zero, size: size))
view.state = .read(events, slots)
view.finishRevealForRendering()

guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { exit(1) }
// 地は窓が持っているので、ここでも敷いてから帯を重ねる。
view.cacheDisplay(in: view.bounds, to: rep)
let image = NSImage(size: size)
image.addRepresentation(rep)

let final = NSImage(size: size)
final.lockFocus()
NSGradient(starting: Room.hex(0x1A1A1A), ending: Room.hex(0x151515))?
    .draw(in: NSRect(origin: .zero, size: size), angle: -90)
image.draw(in: NSRect(origin: .zero, size: size))
final.unlockFocus()

guard let tiff = final.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
