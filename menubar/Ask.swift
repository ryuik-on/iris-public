import AppKit

/**
 * A line to type into, and what came back.
 *
 * The band reports and the square shows where work stands; neither of them
 * lets a question be asked, which is the thing IRIS is actually for. Opening
 * the browser to ask one is the context switch the whole HUD exists to remove.
 *
 * This is deliberately small. It holds one question and one answer and forgets
 * both when it closes — a conversation belongs in the application, where it is
 * recorded and can be returned to. Anything kept here would be a second,
 * shorter history that nothing else knows about.
 */
final class Ask: NSPanel, NSTextFieldDelegate {
    private let field = NSTextField()
    private let reply = NSTextView()
    private let scroll = NSScrollView()
    private let core = CoreView()
    private var asking = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 92),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        appearance = NSAppearance(named: .darkAqua)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        backgroundColor = Palette.groundDeep
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isFloatingPanel = true
        hidesOnDeactivate = false

        let ground = NSView()
        ground.wantsLayer = true
        ground.layer?.backgroundColor = Palette.groundDeep.cgColor
        ground.layer?.borderColor = Palette.line.cgColor
        ground.layer?.borderWidth = 1
        contentView = ground

        core.translatesAutoresizingMaskIntoConstraints = false
        ground.addSubview(core)

        field.translatesAutoresizingMaskIntoConstraints = false
        field.font = NSFont.systemFont(ofSize: 15, weight: .regular)
        field.textColor = Palette.headline
        field.backgroundColor = .clear
        field.isBordered = false
        field.focusRingType = .none
        field.placeholderString = "IRIS に聞く"
        field.delegate = self
        ground.addSubview(field)

        reply.isEditable = false
        reply.drawsBackground = false
        reply.textColor = Palette.aside
        reply.font = NSFont.systemFont(ofSize: 13)
        reply.textContainerInset = NSSize(width: 0, height: 4)
        scroll.documentView = reply
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.isHidden = true
        ground.addSubview(scroll)

        NSLayoutConstraint.activate([
            core.leadingAnchor.constraint(equalTo: ground.leadingAnchor, constant: 16),
            core.topAnchor.constraint(equalTo: ground.topAnchor, constant: 16),
            core.widthAnchor.constraint(equalToConstant: 40),
            core.heightAnchor.constraint(equalToConstant: 40),

            field.leadingAnchor.constraint(equalTo: core.trailingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: ground.trailingAnchor, constant: -18),
            field.centerYAnchor.constraint(equalTo: core.centerYAnchor),

            scroll.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: ground.trailingAnchor, constant: -18),
            scroll.topAnchor.constraint(equalTo: core.bottomAnchor, constant: 10),
            scroll.bottomAnchor.constraint(equalTo: ground.bottomAnchor, constant: -14),
        ])
        core.start()
    }

    override var canBecomeKey: Bool { true }

    /**
     * Three ways out, because the first version had none that worked.
     *
     * The title bar is hidden, so there is no close button; Escape was routed
     * through the text field's delegate and never arrived. A panel that opens
     * over everything and cannot be dismissed is worse than one that does not
     * open — it has to be closable without knowing which key was meant.
     */
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {  // Escape
            dismiss()
            return
        }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) { dismiss() }

    /// Clicking elsewhere dismisses it, the way a panel summoned by a key does.
    override func resignKey() {
        super.resignKey()
        dismiss()
    }

    /// Named `dismiss` rather than `close`: NSWindow already has a `close()`,
    /// and the two would be chosen between silently.
    func dismiss() {
        orderOut(nil)
        // The question and the answer go with it. A conversation belongs in the
        // application, where it is recorded and can be returned to.
        field.stringValue = ""
        reply.string = ""
    }

    /**
     * A voice answer, kept for reading.
     *
     * The band shows two lines and most replies are longer than that. Rather
     * than truncating and losing the rest, the whole thing waits here, and the
     * shortcut that opens this panel opens to it.
     */
    private var held: (question: String, reply: String)?
    var hasHeld: Bool { held != nil }

    func hold(question: String, reply: String) {
        held = (question, reply)
    }

    func presentHeld() {
        guard let held else { return }
        place()
        field.stringValue = held.question
        reply.string = held.reply
        scroll.isHidden = false
        grow()
        self.held = nil
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
    }

    private func place() {
        if let screen = NSScreen.main {
            let area = screen.visibleFrame
            setFrameOrigin(NSPoint(
                x: area.midX - frame.width / 2,
                y: area.maxY - area.height * 0.32
            ))
        }
    }

    func present() {
        // Centred on the screen the pointer is on, a third of the way down —
        // where a thing being addressed belongs, not in a corner.
        place()
        field.stringValue = ""
        reply.string = ""
        scroll.isHidden = true
        shrink()
        // An accessory application has to be brought forward explicitly, or
        // the field never takes the keystrokes it was opened for.
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
        field.becomeFirstResponder()
    }

    func controlTextDidEndEditing(_ note: Notification) {}

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            send()
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            dismiss()
            return true
        }
        return false
    }

    private func shrink() {
        setContentSize(NSSize(width: 560, height: 92))
    }

    private func grow() {
        setContentSize(NSSize(width: 560, height: 320))
    }

    private func send() {
        let question = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !asking else { return }
        asking = true
        core.pace = 2.6
        reply.string = "…"
        scroll.isHidden = false
        grow()

        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/chat")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["message": question])
        request.timeoutInterval = 120

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking = false
                self.core.pace = 1.0
                guard let data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else {
                    // Named, not swallowed. A blank panel after a question
                    // looks like an answer of nothing.
                    self.reply.string = "IRIS に届きませんでした。\(error?.localizedDescription ?? "")"
                    return
                }
                if let pending = body["pendingApproval"] as? [String: Any],
                   let tool = pending["toolName"] as? String {
                    self.reply.string = "承認が必要です（\(tool)）。IRIS を開いて確認してください。"
                    return
                }
                self.reply.string = (body["reply"] as? String) ?? "返答がありません。"
                self.reply.textColor = Palette.aside
            }
        }.resume()
    }
}
