import AppKit

/**
 * 予定を一行で打ち、確かめてから入れる窓。
 *
 * 「聞く」窓と作りが似ているが、流れが違う。あちらは**問い、答え、忘れる**。
 * こちらは**打つ、確かめる、入れる** —— 最後に相手の側へ物が残るので、
 * 途中に人が見る段が要る。
 *
 * ## 確認の段が飾りでない理由
 *
 * この機能でいちばん危ないのは読み違えではなく、**読み違えた予定が正しい顔で
 * 座ること。**「来週の火曜3時」を一週ずらして読んでも、出来上がった予定は
 * 本物と見分けが付かない —— 日付があり、題名が付いていて、カレンダーに並ぶ。
 * 当日まで気づかない。
 *
 * だから確認に出すのは**解決済みの絶対値だけ。**「2026年9月15日(火) 15:00〜」
 * と出れば、一週ずれていれば目で分かる。**打った言い回しは並べない** ——
 * 並べると、読み違えていても「そう書いたから」で通ってしまう。確認は入力との
 * 一致ではなく、結果が正しいかを見る作業。
 *
 * ## 入れる先を毎回選ぶ理由
 *
 * カレンダーが四つある（Google の個人、iCloud の職場と自宅二つ）。既定を
 * 決めて黙って入れると、**間違った箱に入ったことが画面に出ない。**利用者が
 * 「毎回聞く」を選んだのはそのため。
 */
final class Schedule: NSPanel, NSTextFieldDelegate {
    private let field = NSTextField()
    private let summary = NSTextField(labelWithString: "")
    private let subject = NSTextField(labelWithString: "")
    private let notes = NSTextField(labelWithString: "")
    private let targets = NSPopUpButton()
    private let commit = NSButton(title: "登録", target: nil, action: nil)
    private let status = NSTextField(labelWithString: "")

    /// 読めた下書き。**これが無ければ登録は押せない。**
    private var draft: [String: Any]?
    /// 入れる先。`(名前, 識別子, 種類)`。
    private var places: [(name: String, id: String, source: String)] = []
    private var working = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 174),
            styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        appearance = NSAppearance(named: .darkAqua)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        level = .floating
        hidesOnDeactivate = false
        backgroundColor = Palette.Board.ground

        /*
         * 信号機の三つ。**畳んだり広げたりする意味が無い窓なので、閉じるだけ残す。**
         * 盤も同じにしてある（`IrisMenuBar.swift`）。
         */
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        let content = NSView()
        contentView = content

        field.placeholderString = "予定を一行で（例: 来週の火曜15時からガウス）"
        field.font = NSFont.systemFont(ofSize: 14)
        field.delegate = self
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.textColor = Palette.Board.text

        summary.font = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        summary.textColor = Palette.Board.text
        subject.font = NSFont.systemFont(ofSize: 13)
        subject.textColor = Palette.Board.text
        notes.font = NSFont.systemFont(ofSize: 11)
        notes.textColor = Palette.Board.amber
        notes.lineBreakMode = .byWordWrapping
        notes.maximumNumberOfLines = 3
        status.font = NSFont.systemFont(ofSize: 11)
        status.textColor = Palette.Board.subtle

        targets.font = NSFont.systemFont(ofSize: 12)
        commit.bezelStyle = .rounded
        commit.target = self
        commit.action = #selector(register)
        commit.isEnabled = false
        commit.keyEquivalent = "\r"

        for v in [field, summary, subject, notes, targets, commit, status] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }

        let pad: CGFloat = 16
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: pad),
            field.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -pad),
            /*
             * 題名帯のぶんを空ける。
             *
             * `.fullSizeContentView` なので中身は窓の一番上から始まり、**信号機の
             * ボタンは中身の上に重なって置かれる。**16 しか空けていなかったので、
             * 案内の文（「予定を一行で…」）の上に丸が三つ乗っていた（実機で確認）。
             * ボタンは上から 8、高さ 20 ほど。34 空けると下を通る。
             */
            field.topAnchor.constraint(equalTo: content.topAnchor, constant: 38),

            summary.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            summary.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            summary.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 14),

            subject.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            subject.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            subject.topAnchor.constraint(equalTo: summary.bottomAnchor, constant: 3),

            notes.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            notes.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            notes.topAnchor.constraint(equalTo: subject.bottomAnchor, constant: 6),

            targets.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            targets.topAnchor.constraint(equalTo: notes.bottomAnchor, constant: 10),
            targets.widthAnchor.constraint(equalToConstant: 220),

            commit.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            commit.centerYAnchor.constraint(equalTo: targets.centerYAnchor),

            status.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            status.topAnchor.constraint(equalTo: targets.bottomAnchor, constant: 8),
            status.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -pad),
        ])

        clear()
    }

    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }

    func present() {
        clear()
        loadTargets()
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            setFrameOrigin(NSPoint(x: f.midX - frame.width / 2, y: f.midY - frame.height / 2))
        }
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        field.becomeFirstResponder()
    }

    private func clear() {
        field.stringValue = ""
        draft = nil
        summary.stringValue = ""
        subject.stringValue = ""
        notes.stringValue = ""
        status.stringValue = ""
        commit.isEnabled = false
    }

    // MARK: - 入れる先

    /**
     * 入れる先を読む。
     *
     * 落ちた源があれば、**そう書く。**黙って短い一覧を出すと「職場が無い」が
     * 「職場には書けない」に見える。
     */
    private func loadTargets() {
        targets.removeAllItems()
        targets.addItem(withTitle: "読み取り中…")
        places = []

        get("/api/calendar/targets") { [weak self] body in
            guard let self else { return }
            let list = (body?["targets"] as? [[String: Any]]) ?? []
            self.places = list.compactMap { t in
                guard let name = t["name"] as? String,
                      let id = t["id"] as? String,
                      let source = t["source"] as? String else { return nil }
                return (name, id, source)
            }
            self.targets.removeAllItems()
            if self.places.isEmpty {
                self.targets.addItem(withTitle: "入れる先がありません")
                self.commit.isEnabled = false
            } else {
                /*
                 * 名前だけだと見分けが付かない。「自宅」が二つ、「日本の祝日」も
                 * 二つある（実測）—— **同じ名前の別カレンダー**なので、どちらの
                 * 空から来たものかを添える。
                 */
                for p in self.places {
                    self.targets.addItem(withTitle: "\(p.name)（\(p.source == "google" ? "Google" : "iCloud")）")
                }
            }
            if let broken = body?["unavailable"] as? [[String: Any]], !broken.isEmpty {
                let names = broken.compactMap { $0["source"] as? String }.joined(separator: "・")
                self.status.stringValue = "\(names) は読めていないので、その分は一覧に出ていません。"
            }
        }
    }

    // MARK: - 解釈

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            interpret()
            return true
        }
        return false
    }

    private func interpret() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !working else { return }
        working = true
        status.stringValue = "読み取り中…"
        commit.isEnabled = false

        post("/api/calendar/draft", ["text": text]) { [weak self] body in
            guard let self else { return }
            self.working = false
            guard let body else {
                self.status.stringValue = "IRIS に届きませんでした。"
                return
            }
            /*
             * 読めなかったときに、空の予定を見せない。**題名だけの予定を作れる
             * 道を残さない。**
             */
            guard body["readable"] as? Bool == true, let d = body["draft"] as? [String: Any] else {
                self.draft = nil
                self.summary.stringValue = ""
                self.subject.stringValue = ""
                self.notes.stringValue = ""
                self.status.stringValue = (body["reason"] as? String) ?? "予定として読み取れませんでした。"
                return
            }
            self.draft = d
            self.summary.stringValue = (body["summary"] as? String) ?? ""
            self.subject.stringValue = (d["title"] as? String) ?? ""

            /*
             * 欠けと疑いを分けて出す。
             *
             * **欠け**は書かれていなかったもの（終了時刻、場所）。**疑い**は
             * 読み違えの形をしているもの（過去の日付、時刻が落ちて終日に
             * なっている）。前者は足りないだけ、後者は間違っているかもしれない。
             * 同じ色で並べると、後者が見過ごされる。
             */
            let doubts = (d["doubts"] as? [String]) ?? []
            let missing = (d["missing"] as? [String]) ?? []
            var lines: [String] = []
            if !doubts.isEmpty { lines.append("⚠ " + doubts.joined(separator: " / ")) }
            if !missing.isEmpty { lines.append("未記入: " + missing.joined(separator: "・")) }
            self.notes.stringValue = lines.joined(separator: "\n")
            self.notes.textColor = doubts.isEmpty ? Palette.Board.subtle : Palette.Board.amber

            self.status.stringValue = self.places.isEmpty ? "入れる先が読めていません。" : ""
            self.commit.isEnabled = !self.places.isEmpty
        }
    }

    // MARK: - 登録

    @objc private func register() {
        guard let d = draft, !working else { return }
        let index = targets.indexOfSelectedItem
        guard index >= 0, index < places.count else {
            status.stringValue = "入れる先を選んでください。"
            return
        }
        let place = places[index]
        working = true
        commit.isEnabled = false
        status.stringValue = "登録中…"

        var body: [String: Any] = [
            "calendarId": place.id,
            "source": place.source,
            "title": d["title"] as? String ?? "",
            "start": d["start"] as? String ?? "",
            "allDay": d["allDay"] as? Bool ?? false,
        ]
        if let end = d["end"] as? String { body["end"] = end }
        if let where_ = d["location"] as? String { body["location"] = where_ }

        post("/api/calendar/events", body) { [weak self] reply in
            guard let self else { return }
            self.working = false
            guard let reply, reply["ok"] as? Bool == true else {
                /*
                 * 断られた理由をそのまま出す。**「登録できませんでした」だけだと、
                 * 直しに行く先が分からない** —— 権限なのか、届いていないのか、
                 * 相手が断ったのか。
                 */
                let why = (reply?["error"] as? String) ?? (reply?["message"] as? String) ?? "届きませんでした。"
                self.status.stringValue = "登録できませんでした。\(why)"
                self.commit.isEnabled = true
                return
            }
            self.status.stringValue = "\(place.name) に登録しました。"
            self.draft = nil
            self.field.stringValue = ""
            self.summary.stringValue = ""
            self.subject.stringValue = ""
            self.notes.stringValue = ""
        }
    }

    // MARK: - 往復

    private func get(_ path: String, done: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002" + path)!)
        request.timeoutInterval = 20
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(body ?? nil) }
        }.resume()
    }

    private func post(_ path: String, _ payload: [String: Any], done: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002" + path)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        // 模型に一行読ませる往復があるので、聞く窓と同じだけ待つ。
        request.timeoutInterval = 120
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(body ?? nil) }
        }.resume()
    }
}
