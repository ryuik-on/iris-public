import AppKit
import Vision

/**
 * 画面の右に寄せて開く、サイドチャット。
 *
 * 「別の画面にいてもサッとひらけて、簡単な質問ならその場で返せるように」
 * 「サイドチャット」「承認ボタンもつけて」「知らない単語が出たとき、コピペや
 * スクショを貼らずに、読み方を知りたい」（利用者、2026-10-16）。
 *
 * 帯は状況を伝え、盤は仕事の進みを見せるが、どちらも質問はできない。質問は
 * IRIS が本来していることで、**ブラウザを開くのは、HUD が無くそうとしている
 * 画面の切り替え**そのもの。
 *
 * 作りは三つの約束で出来ている。
 *   1. **短く速い**: 声の経路（速いモデル）で答える。長い仕事はアプリの会話で頼む。
 *   2. **続きが話せる**: 答えのあと、同じ会話の続きとして十分間は聞ける。閉じても
 *      画面の記録は残り、開き直すと続きから見える。
 *   3. **承認はここで済む**: 書き換えや連絡を伴う頼みごとは、この窓の中で内容を
 *      見て、承認かやめるかを選べる。**確認の文をチャットで先に聞く、二度手間にはしない**
 *      （承認の画面そのものが確認）。
 *
 * 画面の文字は、**この機械の中で読む**（Vision）。画像は IRIS にも外にも送らず、
 * 読み取った文字だけを「指示ではない、読む対象」と明記して聞く。画面にある
 * 文面が命令として働くのを避けるため。
 */
/**
 * 複数行の入力欄。
 *
 * 1 行用の入力欄（NSTextField）に折り返しを付けても、窓の高さが追いつかず、**最後の行だけが見えて、
 * 前の行が見えなくなった**（利用者、2026-10-17）。テキストビューにして、行が増えたぶん高さも増やす。
 * プレースホルダは、テキストビューには無いので、空のときだけ自分で描く。
 */
final class InputView: NSTextView {
    var placeholderString: String? { didSet { needsDisplay = true } }
    var stringValue: String {
        get { string }
        set { string = newValue; needsDisplay = true }
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, let placeholder = placeholderString else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 14),
            .foregroundColor: Palette.aside,
        ]
        let padding = textContainer?.lineFragmentPadding ?? 0
        NSString(string: placeholder).draw(at: NSPoint(x: textContainerInset.width + padding, y: textContainerInset.height), withAttributes: attributes)
    }
}

final class Ask: NSPanel, NSTextViewDelegate {
    // MARK: 部品
    private let core = CoreView()
    private let field = InputView()
    private let inputScroll = NSScrollView()
    private var inputHeight: NSLayoutConstraint!
    private let transcript = NSTextView()
    private let scroll = NSScrollView()
    private let readButton = NSButton()
    private let windowButton = NSButton()
    private let clipButton = NSButton()
    private let newButton = NSButton()
    private let closeButton = NSButton()

    private let approvalBox = NSStackView()
    private let approvalHeading = NSTextField(wrappingLabelWithString: "")
    private let approvalSummary = NSTextField(wrappingLabelWithString: "")
    private let approveButton = NSButton()
    private let declineButton = NSButton()

    // MARK: 状態
    private var asking = false
    private var conversationId: String?
    private var lastAnswerAt: Date?
    private var approvalSessionId: String?
    private var approvalDetails = ""
    private var clipHandledCount = -1
    private var clipText: String?
    /// 選んだ画面の範囲。外すか、新しい会話にするまで、続きの質問にも付く。
    private var pendingImage: Data?
    private var seeHistory: [(q: String, a: String)] = []
    private var translateMode = false
    /// 他のキーの機能（IRIS のアプリ、予定の登録、暦、盤、レール）を、窓の中から呼ぶボタン。
    /// 中身は HUD 本体が渡す（この窓は、それぞれの窓の作り方を知らない）。
    var shortcuts: [(title: String, hint: String, run: () -> Void)] = [] { didSet { rebuildShortcuts() } }
    private let shortcutRows = NSStackView()
    private let column = NSStackView()
    private let commandsBox = NSStackView()
    private let contextBox = NSStackView()
    private let moreButton = NSButton()
    private let historyButton = NSButton()
    private let attachButton = NSButton()
    private let translateButton = NSButton()
    private let imageNote = NSButton()
    private static let memory: TimeInterval = 10 * 60
    private static let width: CGFloat = 340
    private static let railReserve: CGFloat = 52 + 20

    private var continuing: Bool {
        guard conversationId != nil, let at = lastAnswerAt else { return false }
        return Date().timeIntervalSince(at) < Ask.memory
    }

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: Ask.width, height: 640),
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
        NSLayoutConstraint.activate([
            core.widthAnchor.constraint(equalToConstant: 30),
            core.heightAnchor.constraint(equalToConstant: 30),
        ])

        let title = NSTextField(labelWithString: "IRIS")
        title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        title.textColor = Palette.headline

        style(newButton, "新しい会話", #selector(startOver))
        style(closeButton, "×", #selector(closeTapped))
        style(historyButton, "履歴", #selector(historyTapped))
        historyButton.toolTip = "過去の会話を開く（続きから話せます）"
        style(moreButton, "⋯", #selector(toggleCommands))
        moreButton.toolTip = "コマンドを出す／隠す"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let top = NSStackView(views: [core, title, spacer, historyButton, newButton, moreButton, closeButton])
        top.orientation = .horizontal
        top.alignment = .centerY
        top.spacing = 8

        style(attachButton, "画面の一部を選んで聞く　⌥⌘Y", #selector(attachTapped))
        attachButton.toolTip = "範囲をドラッグすると、その画像を Claude に送って、文脈も踏まえて答えます（⌥⌘Y）。選んだ範囲の画像だけが送られます"
        style(windowButton, "窓を丸ごと選んで聞く（クリックで窓を選ぶ）", #selector(attachWindowTapped))
        windowButton.toolTip = "窓をクリックすると、その窓全体の画像を Claude に送って、ページの文脈も踏まえて答えます"
        style(readButton, "文字だけ読む（この Mac の中で）", #selector(readTapped))
        readButton.toolTip = "範囲の文字だけを、この Mac の中で読み取ります。画像は送りません"
        style(translateButton, "翻訳：オフ", #selector(translateTapped))
        translateButton.toolTip = "オンにすると、入力・コピー・画面の文字を翻訳します（外国語→日本語、日本語→英語）"
        style(imageNote, "", #selector(detachImage))
        imageNote.isHidden = true
        style(clipButton, "", #selector(clipTapped))
        clipButton.isHidden = true
        shortcutRows.orientation = .vertical
        shortcutRows.alignment = .leading
        shortcutRows.spacing = 2
        // コマンドは、「⋯」を押すまで隠す。添付中の印とコピーの候補は、出ていてよい。
        for box in [commandsBox, contextBox] {
            box.orientation = .vertical
            box.alignment = .leading
            box.spacing = 4
        }
        for v in [attachButton, windowButton, readButton, translateButton, shortcutRows] { commandsBox.addArrangedSubview(v) }
        for v in [imageNote, clipButton] { contextBox.addArrangedSubview(v) }
        commandsBox.isHidden = true

        transcript.isEditable = false
        transcript.isSelectable = true
        transcript.drawsBackground = false
        transcript.textColor = Palette.aside
        transcript.font = NSFont.systemFont(ofSize: 13)
        transcript.textContainerInset = NSSize(width: 0, height: 4)
        transcript.isVerticallyResizable = true
        transcript.isHorizontallyResizable = false
        transcript.autoresizingMask = [.width]
        transcript.textContainer?.widthTracksTextView = true
        scroll.documentView = transcript
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)

        approvalHeading.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        approvalHeading.textColor = Palette.attention
        approvalSummary.font = NSFont.systemFont(ofSize: 12)
        approvalSummary.textColor = Palette.headline
        approvalSummary.maximumNumberOfLines = 0
        approvalHeading.preferredMaxLayoutWidth = Ask.width - 52
        approvalSummary.preferredMaxLayoutWidth = Ask.width - 52
        style(approveButton, "承認する", #selector(approveTapped))
        approveButton.contentTintColor = Palette.accent
        style(declineButton, "やめる", #selector(declineTapped))
        let decide = NSStackView(views: [approveButton, declineButton])
        decide.orientation = .horizontal
        decide.spacing = 14
        approvalBox.orientation = .vertical
        approvalBox.alignment = .leading
        approvalBox.spacing = 6
        approvalBox.edgeInsets = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        approvalBox.addArrangedSubview(approvalHeading)
        approvalBox.addArrangedSubview(approvalSummary)
        let detailsButton = NSButton(title: "操作の詳細", target: self, action: #selector(showApprovalDetails))
        detailsButton.bezelStyle = .inline
        approvalBox.addArrangedSubview(detailsButton)
        approvalBox.addArrangedSubview(decide)
        approvalBox.wantsLayer = true
        approvalBox.layer?.borderColor = Palette.attention.cgColor
        approvalBox.layer?.borderWidth = 1
        approvalBox.layer?.cornerRadius = 8
        approvalBox.isHidden = true

        field.font = NSFont.systemFont(ofSize: 14)
        field.textColor = Palette.headline
        field.insertionPointColor = Palette.accent
        field.drawsBackground = false
        field.isRichText = false
        field.allowsUndo = true
        field.focusRingType = .none
        field.textContainerInset = NSSize(width: 0, height: 3)
        field.isVerticallyResizable = true
        field.isHorizontallyResizable = false
        field.autoresizingMask = [.width]
        field.textContainer?.widthTracksTextView = true
        field.placeholderString = "IRIS に聞く"
        field.delegate = self
        // 行が増えたぶんだけ高さが増える（最大およそ 8 行。それ以上は中でスクロール）。
        inputScroll.documentView = field
        inputScroll.drawsBackground = false
        inputScroll.borderType = .noBorder
        inputScroll.hasVerticalScroller = true
        inputScroll.autohidesScrollers = true
        inputScroll.translatesAutoresizingMaskIntoConstraints = false
        inputHeight = inputScroll.heightAnchor.constraint(equalToConstant: 26)
        inputHeight.isActive = true
        let rule = NSBox()
        rule.boxType = .separator

        for v in [top, commandsBox, contextBox, scroll, approvalBox, rule, inputScroll] { column.addArrangedSubview(v) }
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 8
        column.translatesAutoresizingMaskIntoConstraints = false
        ground.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: ground.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: ground.trailingAnchor, constant: -16),
            column.topAnchor.constraint(equalTo: ground.topAnchor, constant: 14),
            column.bottomAnchor.constraint(equalTo: ground.bottomAnchor, constant: -14),
            top.widthAnchor.constraint(equalTo: column.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: column.widthAnchor),
            approvalBox.widthAnchor.constraint(equalTo: column.widthAnchor),
            rule.widthAnchor.constraint(equalTo: column.widthAnchor),
            inputScroll.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        core.start()
    }

    private func style(_ button: NSButton, _ title: String, _ action: Selector) {
        button.title = title
        button.isBordered = false
        button.bezelStyle = .inline
        button.font = NSFont.systemFont(ofSize: 12)
        button.contentTintColor = Palette.aside
        button.target = self
        button.action = action
    }

    private func rebuildShortcuts() {
        for row in shortcutRows.arrangedSubviews { shortcutRows.removeArrangedSubview(row); row.removeFromSuperview() }
        var index = 0
        var line = NSStackView()
        func flush() {
            guard !line.arrangedSubviews.isEmpty else { return }
            line.orientation = .horizontal
            line.spacing = 14
            shortcutRows.addArrangedSubview(line)
            line = NSStackView()
        }
        for item in shortcuts {
            let button = NSButton()
            style(button, "\(item.title) \(item.hint)", #selector(shortcutTapped(_:)))
            button.tag = index
            line.addArrangedSubview(button)
            index += 1
            if line.arrangedSubviews.count == 2 { flush() }
        }
        flush()
    }

    @objc private func shortcutTapped(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < shortcuts.count else { return }
        shortcuts[sender.tag].run()
    }

    override var canBecomeKey: Bool { true }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { dismiss(); return }  // Escape
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) { dismiss() }

    /// 閉じるのは、×・Esc・開いたキーをもう一度、のどれか。**外を押しても閉じない**
    /// （横に置いたまま、他の画面で作業するための窓）。
    func dismiss() { orderOut(nil) }

    @objc private func closeTapped() { dismiss() }

    // MARK: 開く・置く

    private func place() { fit() }

    @objc private func toggleCommands() {
        commandsBox.isHidden.toggle()
        fit()
    }

    /// 右上に、中身に合わせた高さで置く。小さく始めて、やりとりが増えたぶんだけ伸びる
    /// （上の辺は動かさない）。右のレールの左に、すきまを空ける。
    private func fit() {
        guard let screen = NSScreen.main else { return }
        let area = screen.visibleFrame
        if let manager = transcript.layoutManager, let container = transcript.textContainer { manager.ensureLayout(for: container) }
        let used = transcript.layoutManager.flatMap { m in transcript.textContainer.map { m.usedRect(for: $0).height } } ?? 0
        scroll.isHidden = transcript.string.isEmpty
        column.layoutSubtreeIfNeeded()
        let shown = column.arrangedSubviews.filter { !$0.isHidden }
        var wanted: CGFloat = 28 + CGFloat(max(0, shown.count - 1)) * column.spacing
        for view in shown where view !== scroll { wanted += view.fittingSize.height }
        if !scroll.isHidden { wanted += min(used + 12, 380) }
        let height = min(max(wanted, 110), area.height - 24)
        let frame = NSRect(
            x: area.maxX - Ask.railReserve - Ask.width - 8,
            y: area.maxY - 12 - height,
            width: Ask.width, height: height
        )
        setFrame(frame, display: true)
    }

    func present() {
        place()
        if !continuing && conversationId != nil {
            conversationId = nil
            appendNote("— ここから新しい会話 —")
        }
        field.placeholderString = continuing ? "続けて聞く（さっきの話の続きです）" : "IRIS に聞く"
        refreshClipboardChip()
        fit()
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
        makeFirstResponder(field)
    }

    // MARK: 声で聞いた答え（帯は二行しか出せないので、全文をここに）

    private var held: (question: String, reply: String)?
    var hasHeld: Bool { held != nil }

    func hold(question: String, reply: String) { held = (question, reply) }

    func presentHeld() {
        guard let held else { return }
        self.held = nil
        present()
        appendUser(held.question)
        appendReply(held.reply)
    }

    // MARK: 書く

    private func append(_ text: String, color: NSColor, bold: Bool = false, gap: CGFloat = 8, tidy: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = gap
        paragraph.lineSpacing = 2
        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: bold ? .semibold : .regular),
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]
        let attributed = tidy
            ? Ask.render(text, base: base, color: color)
            : NSMutableAttributedString(string: text, attributes: base)
        attributed.append(NSAttributedString(string: "\n", attributes: base))
        transcript.textStorage?.append(attributed)
        transcript.scrollToEndOfDocument(nil)
        fit()
    }

    /// モデルの答えに残るマークダウンの記号を、記号のまま見せない。
    /// 太字は太く、コードは等幅に、箇条書きは「・」に、見出しは太字の行に。空行は詰める。
    private static func render(_ raw: String, base: [NSAttributedString.Key: Any], color: NSColor) -> NSMutableAttributedString {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        // 行頭の整形
        let lines = text.components(separatedBy: "\n").map { line -> String in
            var l = line
            if let r = l.range(of: "^\\s*[-*+]\\s+", options: .regularExpression) { l.replaceSubrange(r, with: "・") }
            if let r = l.range(of: "^\\s*#{1,6}\\s*", options: .regularExpression) { l.replaceSubrange(r, with: "") }
            return l
        }
        text = lines.joined(separator: "\n")
        let out = NSMutableAttributedString(string: text, attributes: base)
        func apply(_ pattern: String, _ attributes: [NSAttributedString.Key: Any]) {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
            // 後ろから置き換える（前の範囲がずれないように）。記号は消し、中身に装飾を付ける。
            let matches = regex.matches(in: out.string, range: NSRange(location: 0, length: out.length)).reversed()
            for m in matches where m.numberOfRanges > 1 {
                let inner = out.attributedSubstring(from: m.range(at: 1)).mutableCopy() as! NSMutableAttributedString
                inner.addAttributes(attributes, range: NSRange(location: 0, length: inner.length))
                out.replaceCharacters(in: m.range, with: inner)
            }
        }
        apply("\\*\\*(.+?)\\*\\*", [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)])
        apply("`([^`\\n]+)`", [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: Palette.accent])
        return out
    }

    private func appendUser(_ text: String) { append(text, color: Palette.accent, bold: true, gap: 2) }
    private func appendReply(_ text: String) { append(text, color: Palette.headline, tidy: true) }
    private func appendNote(_ text: String) { append(text, color: Palette.aside) }

    @objc private func startOver() {
        conversationId = nil
        lastAnswerAt = nil
        transcript.string = ""
        detachImage()
        seeHistory = []
        hideApproval()
        field.placeholderString = "IRIS に聞く"
        makeFirstResponder(field)
    }

    // MARK: 履歴

    /// 過去の会話を新しい順に二十件、メニューで出す。選ぶと、その会話を窓に開いて、続きから聞ける。
    @objc private func historyTapped() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/conversations")!)
        request.timeoutInterval = 10
        IrisHTTP.dataTask(with: request) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let list = body["conversations"] as? [[String: Any]]
                else { self.appendNote("履歴を読めませんでした。"); return }
                let recent = list
                    .filter { ($0["messageCount"] as? Int ?? 0) > 0 }
                    .sorted { ($0["updatedAt"] as? String ?? "") > ($1["updatedAt"] as? String ?? "") }
                    .prefix(20)
                if recent.isEmpty { self.appendNote("過去の会話はまだありません。"); return }
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let shown = DateFormatter()
                shown.dateFormat = "M/d HH:mm"
                let menu = NSMenu()
                for c in recent {
                    guard let id = c["id"] as? String else { continue }
                    var title = ((c["title"] as? String) ?? "（題なし）").replacingOccurrences(of: "\n", with: " ")
                    if title.count > 26 { title = String(title.prefix(25)) + "…" }
                    let when = (c["updatedAt"] as? String).flatMap { parser.date(from: $0) }.map { shown.string(from: $0) } ?? ""
                    let item = NSMenuItem(title: "\(when)　\(title)", action: #selector(self.openHistory(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = id
                    menu.addItem(item)
                }
                menu.popUp(positioning: nil, at: NSPoint(x: 0, y: self.historyButton.bounds.height), in: self.historyButton)
            }
        }.resume()
    }

    @objc private func openHistory(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/conversations/\(id)")!)
        request.timeoutInterval = 10
        IrisHTTP.dataTask(with: request) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let messages = body["messages"] as? [[String: Any]]
                else { self.appendNote("その会話を読めませんでした。"); return }
                self.transcript.string = ""
                self.detachImage()
                self.seeHistory = []
                self.hideApproval()
                // 長い会話は、最後の三十件だけ見せる。
                for m in messages.suffix(30) {
                    let text = (m["content"] as? String) ?? ""
                    guard !text.isEmpty else { continue }
                    switch m["role"] as? String {
                    case "user": self.appendUser(text.count > 300 ? String(text.prefix(300)) + "…" : text)
                    case "assistant": self.appendReply(text)
                    default: break
                    }
                }
                // この会話の続きとして聞ける。
                self.conversationId = id
                self.lastAnswerAt = Date()
                self.field.placeholderString = "続けて聞く（この会話の続きです）"
                self.makeFirstResponder(self.field)
            }
        }.resume()
    }

    // MARK: 聞く

    func textDidChange(_ notification: Notification) {
        resizeInput()
    }

    /// 入力の中身に合わせて、入力欄の高さと窓の高さを決める。
    private func resizeInput() {
        guard let manager = field.layoutManager, let container = field.textContainer else { return }
        manager.ensureLayout(for: container)
        let lines = manager.usedRect(for: container).height + field.textContainerInset.height * 2
        inputHeight.constant = min(max(lines, 26), 168)
        fit()
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            // Shift（または Option）+ Return は改行。Return だけが送る。
            let held = NSApp.currentEvent?.modifierFlags ?? []
            if held.contains(.shift) || held.contains(.option) {
                textView.insertText("\n", replacementRange: textView.selectedRange())
                return true
            }
            send()
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) { dismiss(); return true }
        return false
    }

    private func send() {
        let question = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if question.isEmpty, pendingImage == nil, translateMode, let clip = clipText { clipTapped(); _ = clip; return }
        guard !question.isEmpty || pendingImage != nil else { return }
        field.stringValue = ""
        resizeInput()
        if pendingImage != nil { see(question) }
        else if translateMode { lookUp(question, source: "入力", translate: true) }
        else { ask(question, shown: question) }
    }

    /// `shown` は画面に出す題、`question` は実際に送る文。
    private func ask(_ question: String, shown: String) {
        guard !asking else { appendNote("前の質問に答えている途中です。少し待ってください。"); return }
        guard approvalSessionId == nil else { appendNote("承認の返事が先です。承認するか、やめるかを選んでください。"); return }
        asking = true
        core.pace = 2.6
        appendUser(shown)
        appendNote("…")

        // 声の経路（短く、速い）で答えてもらう。長い仕事はアプリの会話で頼む。
        var payload: [String: Any] = ["message": question, "channel": "voice"]
        if continuing, let id = conversationId { payload["conversationId"] = id }
        post("/api/chat", payload)
    }

    private func post(_ path: String, _ payload: [String: Any]) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 120

        IrisHTTP.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking = false
                self.core.pace = 1.0
                self.dropPlaceholder()
                guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    // 名前を付けて出す。質問のあとの空白は、「何も無い」という答えに見える。
                    self.appendNote("IRIS に届きませんでした。\(error?.localizedDescription ?? "")")
                    return
                }
                self.handle(body)
            }
        }.resume()
    }

    /// 「…」の行を消す。
    private func dropPlaceholder() {
        guard let storage = transcript.textStorage else { return }
        let text = storage.string as NSString
        let range = text.range(of: "…\n", options: .backwards)
        if range.location != NSNotFound, range.location + range.length == text.length {
            storage.deleteCharacters(in: range)
            fit()
        }
    }

    private func handle(_ body: [String: Any]) {
        if let id = body["conversationId"] as? String { conversationId = id }
        approvalSessionId = nil
        if let pending = body["pendingApproval"] as? [String: Any] {
            let heading = (pending["heading"] as? String) ?? "確認してください"
            let summary = (pending["summary"] as? String) ?? ((pending["toolName"] as? String) ?? "")
            approvalSessionId = body["sessionId"] as? String
            // 承認の画面は、**何に同意するのかが見えて初めて**意味がある。アプリの画面と同じく、
            // 事実の一覧と、道具の名前・危険度も出す。内容が出せないときは、承認させない。
            var lines: [String] = []
            if let facts = pending["facts"] as? [[String: Any]] {
                for f in facts {
                    if let label = f["label"] as? String, let value = f["value"] as? String { lines.append("\(label): \(value)") }
                }
            }
            let tool = (pending["toolName"] as? String) ?? "不明"
            let risk = (pending["riskLevel"] as? String) ?? "不明"
            lines.append("道具: \(tool)（\(risk)）")
            let arguments = pending["args"] as? [String: Any]
            let detail = arguments.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) }
            let description = (pending["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            approvalDetails = ["道具: \(tool)（\(risk)）", description.isEmpty ? "道具の説明を取得できませんでした。" : description, detail.flatMap { String(data: $0, encoding: .utf8) } ?? "操作の引数を取得できませんでした。"].joined(separator: "\n\n")
            let readable = !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && detail != nil && !description.isEmpty && !tool.isEmpty && tool != "不明" && ["READ", "WRITE", "EXTERNAL_ACTION", "DESTRUCTIVE"].contains(risk) && approvalSessionId != nil
            showApproval(heading: heading, summary: readable ? ([summary] + lines).joined(separator: "\n") : "内容を表示できません。IRIS のアプリを開いて確認してください。", canApprove: readable)
            return
        }
        if let reply = body["reply"] as? String, !reply.isEmpty {
            appendReply(reply)
        } else if let message = body["error"] as? String {
            appendNote(message)
        } else {
            appendNote("返答がありません。")
        }
        lastAnswerAt = Date()
        field.placeholderString = "続けて聞く"
        makeFirstResponder(field)
    }

    // MARK: 承認

#if IRIS_APPROVAL_PREVIEW
    func previewApproval() {
        handle(["pendingApproval": [
            "heading": "ファイルを保存しますか？", "summary": "検査用の架空ファイルへ保存します。",
            "toolName": "write_file", "riskLevel": "WRITE", "description": "指定したファイルへ内容を保存する道具です。",
            "args": ["path": "検査専用/例.txt", "content": String(repeating: "表示確認用の文章です。\n", count: 40) + "末尾の確認：ここまで表示されます。"]
        ]])
        approveButton.isEnabled = false
    }
#endif

    @objc private func showApprovalDetails() {
        let alert = NSAlert()
        alert.messageText = "実行する操作の詳細"
        alert.informativeText = "対象と内容を確認してください。この画面を閉じても操作は実行されません。"
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 260))
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false
        text.isSelectable = true
        text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        text.string = approvalDetails
        text.autoresizingMask = [.width]
        text.isHorizontallyResizable = false
        text.textContainer?.widthTracksTextView = true
        scroll.documentView = text
        alert.accessoryView = scroll
        alert.addButton(withTitle: "閉じる")
        alert.runModal()
    }

    private func showApproval(heading: String, summary: String, canApprove: Bool) {
        approvalHeading.stringValue = heading
        approvalSummary.stringValue = summary
        approvalBox.isHidden = false
        approveButton.isEnabled = canApprove
        defer { fit() }
        declineButton.isEnabled = true
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
    }

    private func hideApproval() {
        approvalBox.isHidden = true
        approvalSessionId = nil
        fit()
    }

    @objc private func approveTapped() { decide(true) }
    @objc private func declineTapped() { decide(false) }

    private func decide(_ approved: Bool) {
        guard let session = approvalSessionId, !asking else { return }
        approveButton.isEnabled = false
        declineButton.isEnabled = false
        asking = true
        core.pace = 2.6
        appendNote(approved ? "承認しました。" : "やめました。")
        approvalBox.isHidden = true
        post("/api/chat/approve", ["sessionId": session, "approved": approved])
    }

    // MARK: 画面の文字・コピーした文

    /// 範囲をドラッグして選び、その画像を添える（⌥⌘Y）。質問は、そのあとに打つ。
    /// 空のまま Return なら、「何が書かれているか」を文脈つきで説明してもらう。
    func readScreen(window: Bool = false) { captureRegion(window: window) { [weak self] data, _ in
        guard let self else { return }
        self.present()
        guard let data else { self.appendNote("範囲が選ばれませんでした（Esc で取りやめたか、画面収録が許可されていない可能性があります）。"); return }
        self.pendingImage = data
        self.imageNote.title = "📎 選んだ範囲を添付中（外す）"
        self.imageNote.isHidden = false
        self.fit()
        self.appendNote(self.translateMode
            ? "範囲を添えました。Return でこの範囲の文章を翻訳します（選んだ範囲の画像を、Claude に送ります）。"
            : "範囲を添えました。聞きたいことを打つか、空のまま Return で説明します（選んだ範囲の画像を、Claude に送ります）。")
        self.field.placeholderString = "この範囲について聞く"
    } }

    @objc private func attachTapped() { readScreen() }
    @objc private func attachWindowTapped() { readScreen(window: true) }

    @objc private func detachImage() {
        pendingImage = nil
        imageNote.isHidden = true
        fit()
        field.placeholderString = continuing ? "続けて聞く" : "IRIS に聞く"
    }

    /// 文字だけを、この Mac の中で読む。画像はどこにも送らない。
    func readTextOnly() { captureRegion { [weak self] data, url in
        guard let self else { return }
        self.present()
        guard data != nil, let url else { self.appendNote("読み取りをやめました。"); return }
        let text = Ask.recognise(url)
        try? FileManager.default.removeItem(at: url)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.appendNote("文字を読み取れませんでした。初めてなら、システム設定 → プライバシーとセキュリティ → 画面収録 で「IRIS HUD」を許可してください。")
        } else {
            self.lookUp(text, source: "画面", translate: self.translateMode)
        }
    } }

    @objc private func readTapped() { readTextOnly() }

    @objc private func translateTapped() {
        translateMode.toggle()
        translateButton.title = translateMode ? "翻訳：オン" : "翻訳：オフ"
        translateButton.contentTintColor = translateMode ? Palette.accent : Palette.aside
        field.placeholderString = translateMode ? "翻訳する文を入力（空のまま Return で、コピーした文）" : "IRIS に聞く"
    }

    /// 画面の範囲を選ばせ、小さく縮めた JPEG にして返す。`url` は文字読み用の元画像
    /// （呼び出し側が消す）。窓自体が写り込まないように、選ぶあいだは隠す。
    private func captureRegion(window: Bool = false, _ done: @escaping (Data?, URL?) -> Void) {
        trace("capture: start")
        orderOut(nil)
        let path = NSTemporaryDirectory() + "iris-read-\(UUID().uuidString).png"
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            task.arguments = window ? ["-i", "-w", "-x", "-t", "png", path] : ["-i", "-x", "-t", "png", path]
            var started = true
            do { try task.run() } catch { started = false; trace("capture: could not run screencapture: \(error)") }
            if started { task.waitUntilExit() }
            let url = URL(fileURLWithPath: path)
            let found = FileManager.default.fileExists(atPath: path)
            let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
            trace("capture: started=\(started) status=\(started ? task.terminationStatus : -1) found=\(found) bytes=\(bytes)")
            let data = found ? Ask.shrunk(url) : nil
            trace("capture: shrunk=\(data?.count ?? 0)")
            DispatchQueue.main.async {
                if !started { self.present(); self.appendNote("画面の撮影を始められませんでした。"); done(nil, nil); return }
                if !found { done(nil, nil); return }
                done(data, url)
                // 画像の添付だけのときは、元画像を残さない（文字読みは自分で消す）。
                if self.pendingImage != nil, data != nil { try? FileManager.default.removeItem(at: url) }
            }
        }
    }

    private static func shrunk(_ url: URL, maxEdge: CGFloat = 1600) -> Data? {
        guard let image = NSImage(contentsOf: url), let rep = image.representations.first else { return nil }
        let w = CGFloat(rep.pixelsWide), h = CGFloat(rep.pixelsHigh)
        guard w > 0, h > 0 else { return nil }
        let scale = min(1, maxEdge / max(w, h))
        let size = NSSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82])
    }

    /// 選んだ範囲の画像を、質問と一緒に送る。道具も会話の履歴も持たない専用の口（/api/see）へ。
    private func see(_ question: String) {
        guard !asking, let image = pendingImage else { return }
        asking = true
        core.pace = 2.6
        appendUser(question.isEmpty ? (translateMode ? "（この範囲を翻訳）" : "（この範囲を説明）") : question)
        appendNote("…")
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/see")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let history = seeHistory.suffix(3).map { ["q": $0.q, "a": $0.a] }
        var payload: [String: Any] = [
            "imageBase64": image.base64EncodedString(), "mime": "image/jpeg",
            "mode": translateMode ? "translate" : "ask", "history": history,
        ]
        if !question.isEmpty { payload["question"] = question }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 120
        IrisHTTP.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking = false
                self.core.pace = 1.0
                self.dropPlaceholder()
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if let reply = json?["reply"] as? String, !reply.isEmpty {
                    self.appendReply(reply)
                    self.seeHistory.append((q: question.isEmpty ? "この範囲について" : question, a: reply))
                    self.lastAnswerAt = Date()
                } else {
                    self.appendNote((json?["error"] as? String) ?? "IRIS に届きませんでした。\(error?.localizedDescription ?? "")")
                }
                self.makeFirstResponder(self.field)
            }
        }.resume()
    }

    private static func recognise(_ url: URL) -> String {
        guard let image = NSImage(contentsOf: url),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "" }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ja-JP", "en-US"]
        request.usesLanguageCorrection = true
        try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
        return (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }

    private func refreshClipboardChip() {
        let board = NSPasteboard.general
        let text = board.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !text.isEmpty, text.count <= 400, board.changeCount != clipHandledCount {
            clipText = text
            let preview = text.replacingOccurrences(of: "\n", with: " ")
            clipButton.title = "コピーした文を調べる：「\(preview.prefix(14))\(preview.count > 14 ? "…" : "")」"
            clipButton.isHidden = false
        } else {
            clipText = nil
            clipButton.isHidden = true
        }
    }

    @objc private func clipTapped() {
        guard let text = clipText else { return }
        clipHandledCount = NSPasteboard.general.changeCount
        clipButton.isHidden = true
        lookUp(text, source: "コピー", translate: translateMode)
    }

    /// 読む対象を、**指示ではない**と明記して聞く。画面やコピーした文の中に命令の形の
    /// 文があっても、IRIS はそれに従わない。
    private func lookUp(_ text: String, source: String, translate: Bool = false) {
        guard !asking else { appendNote("前の質問に答えている途中です。少し待ってください。"); return }
        let body = String(text.prefix(translate ? 4000 : 800))
        let preview = body.replacingOccurrences(of: "\n", with: " ")
        asking = true
        core.pace = 2.6
        appendUser("\(source)の「\(preview.prefix(40))\(preview.count > 40 ? "…" : "")」\(translate ? "を翻訳" : "の読み方と意味")")
        appendNote("…")
        // 道具も履歴も持たない専用の口へ。画面の文面に命令の形の文があっても、
        // 会話の中の IRIS（道具を呼べる）には入らない。
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/lookup")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": body, "source": source, "mode": translate ? "translate" : "lookup"])
        request.timeoutInterval = 60
        IrisHTTP.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking = false
                self.core.pace = 1.0
                self.dropPlaceholder()
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if let reply = json?["reply"] as? String, !reply.isEmpty {
                    self.appendReply(reply)
                } else {
                    self.appendNote((json?["error"] as? String) ?? "IRIS に届きませんでした。\(error?.localizedDescription ?? "")")
                }
                self.makeFirstResponder(self.field)
            }
        }.resume()
    }
}
