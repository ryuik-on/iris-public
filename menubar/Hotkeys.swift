import AppKit
import Carbon.HIToolbox

/// A line to a file. Guessing at whether an event arrives has cost three
/// attempts on this control already; measuring it costs one function.
func trace(_ text: String) {
    let line = "\(Date().timeIntervalSince1970) \(text)\n"
    guard let data = line.data(using: .utf8) else { return }
    let path = "/tmp/iris-hud.log"
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

/**
 * Global shortcuts, without asking for accessibility.
 *
 * `NSEvent.addGlobalMonitorForEvents` is the obvious route and it is the wrong
 * one for keys: watching the keyboard across applications requires the
 * accessibility permission, which is a large thing to ask for three shortcuts
 * and a prompt the person has to answer before anything works.
 *
 * `RegisterEventHotKey` predates all of that and needs no permission, because
 * it does not observe the keyboard — it asks the window server to deliver one
 * specific combination. Nothing else is visible to it, which is also the honest
 * shape for what this needs.
 */
final class Hotkeys {
    struct Binding {
        let key: Int
        let modifiers: Int
        let action: () -> Void
    }

    private var handlers: [UInt32: () -> Void] = [:]
    private var releases: [UInt32: () -> Void] = [:]
    private var registered: [EventHotKeyRef?] = []
    private var next: UInt32 = 1

    init() {
        // Both edges. A key that can be *held* needs the release as much as the
        // press: push-to-talk is defined by when the microphone closes.
        var types = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ),
        ]
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, context in
                guard let event, let context else { return noErr }
                var id = EventHotKeyID()
                GetEventParameter(
                    event, EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID), nil,
                    MemoryLayout<EventHotKeyID>.size, nil, &id
                )
                let owner = Unmanaged<Hotkeys>.fromOpaque(context).takeUnretainedValue()
                let released = GetEventKind(event) == UInt32(kEventHotKeyReleased)
                trace("hotkey id=\(id.id) \(released ? "released" : "pressed")")
                if released {
                    owner.releases[id.id]?()
                } else {
                    owner.handlers[id.id]?()
                }
                return noErr
            },
            2, &types, Unmanaged.passUnretained(self).toOpaque(), nil
        )
    }

    /**
     * Returns whether the combination was actually taken.
     *
     * The status was discarded in the first version, and a failed registration
     * is silent and consequential: the key is simply not reserved, so it falls
     * through to whatever application is in front and does whatever that
     * application does with it. From the outside that looks like IRIS doing
     * something strange, when IRIS never saw the keystroke at all.
     */
    @discardableResult
    func bind(
        _ key: Int, _ modifiers: Int, _ name: String,
        _ action: @escaping () -> Void,
        released: (() -> Void)? = nil
    ) -> Bool {
        let id = next
        next += 1
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(key), UInt32(modifiers),
            EventHotKeyID(signature: OSType(0x49525321), id: id),  // 'IRS!'
            GetApplicationEventTarget(), 0, &ref
        )
        guard status == noErr, ref != nil else {
            NSLog("IRIS: hotkey %@ was refused (status %d) — the key still belongs to whatever is in front", name, status)
            failures.append(name)
            return false
        }
        handlers[id] = action
        releases[id] = released
        registered.append(ref)
        return true
    }

    /// Combinations another application already holds. Reported, not hidden.
    private(set) var failures: [String] = []
}
