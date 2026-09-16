import AppKit

/**
 * 一日の形を、一押しで。
 *
 * 「コマンドで一発で出せる？」（利用者、2026-09-09。**キーのこと**で、端末の
 * コマンドのことではない）。時刻の一覧は、空きを引き算で出させる —— 帯なら
 * 「昼から夕方までまるごと空いている」が形として一目で入る。
 *
 * ## 窓に置いた理由
 *
 * 盤（⌥⌘D）には既に「今日」の欄がある。そちらへ足すと、8時から24時までの帯で
 * 盤が画面から溢れる（2026-09-08 に「今日」を足したとき、進行状況が下から
 * 落ちた）。**別の窓にして、開けたいときだけ開ける。**
 *
 * ## 出典
 *
 * `/api/schedule` —— **画面の帯（`src/components/Telemetry.tsx`）と端末
 * （`scripts/day.ts`）が読むのと同じ口。**ここで日を数え直すと、三つの場所が
 * 別々に間違えられるようになり、どれが正しいか誰にも言えなくなる。
 */
final class Day: NSPanel {
    private let band = DayBandView()
    private let head = NSTextField(labelWithString: "")
    private let note = NSTextField(labelWithString: "")
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        /*
         * 60秒。**20秒では足りなかった**（実測 2026-09-09、アプリ起動直後の
         * 一回目が `The request timed out.` で落ちた）。温まっていれば
         * `/api/schedule` は 2.8〜5.1秒で返るが、初回は Google の再認可と
         * CalDAV の読みが乗る。**遅いことと落ちていることは別。**待つ。
         */
        config.timeoutIntervalForRequest = 60
        session = URLSession(configuration: config)
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
            styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        appearance = NSAppearance(named: .darkAqua)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        level = .floating
        hidesOnDeactivate = false
        /*
         * 押した Space に来る。
         *
         * 既定だと窓は**作られた Space に残る。**⌥⌘K を押しても何も出ない
         * ように見えて、実際は別の画面で開いている（実測 2026-09-09、二度
         * これで見失った）。呼び出しキーで出すものは、呼んだ場所に出るのが
         * 正しい。`canJoinAllSpaces` ではなく `moveToActiveSpace` —— 全部の
         * Space に居座る窓は、閉じたつもりの窓が付いて回る。
         */
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        backgroundColor = Room.ground
        // 畳む・広げるに意味の無い窓なので、閉じるだけ残す（`Schedule` と同じ）。
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        let body = DayGround(frame: contentRect(forFrameRect: frame))
        head.font = .systemFont(ofSize: 13, weight: .semibold)
        head.textColor = Room.ink
        note.font = .systemFont(ofSize: 11)
        note.textColor = Room.muted
        note.lineBreakMode = .byTruncatingTail
        for v in [head, note, band] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            body.addSubview(v)
        }
        NSLayoutConstraint.activate([
            head.leadingAnchor.constraint(equalTo: body.leadingAnchor, constant: 18),
            head.trailingAnchor.constraint(equalTo: body.trailingAnchor, constant: -18),
            head.topAnchor.constraint(equalTo: body.topAnchor, constant: 34),
            note.leadingAnchor.constraint(equalTo: head.leadingAnchor),
            note.trailingAnchor.constraint(equalTo: head.trailingAnchor),
            note.topAnchor.constraint(equalTo: head.bottomAnchor, constant: 4),
            band.leadingAnchor.constraint(equalTo: body.leadingAnchor, constant: 14),
            band.trailingAnchor.constraint(equalTo: body.trailingAnchor, constant: -14),
            band.topAnchor.constraint(equalTo: note.bottomAnchor, constant: 12),
            band.bottomAnchor.constraint(equalTo: body.bottomAnchor, constant: -16),
        ])
        contentView = body
    }

    func present() {
        /*
         * **マウスのいる画面の、中に収める。**
         *
         * `NSScreen.main` は「キー窓のある画面」で、この窓を呼ぶときに
         * キー窓がどこにあるかは分からない。実測 2026-09-09、窓は原点 -20 に
         * 置かれて**左端から半分はみ出していた**（時刻の列が画面の外）。
         * 中央に置いた結果ではなく、別の画面の中央を計算していた。
         *
         * 収めるところまでやる。中央に置く計算が合っていても、画面より
         * 大きい窓や作業領域の狭い画面では外に出る。
         */
        let point = NSEvent.mouseLocation
        /*
         * 最後に `NSScreen.screens.first` を置く。**`NSScreen.main` は nil を
         * 返しうる** —— キー窓のある画面という意味なので、窓を一つも持たない
         * 常駐アプリでは指す先が無い。実測 2026-09-09、ここが nil で位置合わせが
         * 丸ごと飛び、窓は前の位置（画面の下へ突き抜けたまま）で開いていた。
         * **落ちない道を残す、を位置にも。**
         */
        let screen = NSScreen.screens.first { $0.frame.contains(point) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        if let f = screen?.visibleFrame {
            var x = f.midX - frame.width / 2
            var y = f.midY - frame.height / 2
            x = min(max(x, f.minX + 8), f.maxX - frame.width - 8)
            y = min(max(y, f.minY + 8), f.maxY - frame.height - 8)
            setFrameOrigin(NSPoint(x: x, y: y))
        }
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        reload()
    }

    func dismiss() { orderOut(nil) }

    /**
     * 読めなかったことを、予定が無いことにしない。
     *
     * 空の帯は「今日は何も無い」と読める絵で、**読めなかった日と見分けが
     * 付かない。**読めなければ帯を消して理由を出す。
     */
    private func reload() {
        head.stringValue = "今日"
        note.stringValue = "読み込み中…"
        band.state = .waiting
        guard let url = URL(string: "http://127.0.0.1:3002/api/schedule?days=1") else { return }
        session.dataTask(with: url) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data, status == 200,
                  let reading = try? JSONDecoder().decode(DayReading.self, from: data)
            else {
                var why = error?.localizedDescription ?? (status == 0 ? "IRIS に届きません" : "HTTP \(status)")
            if (error as NSError?)?.code == NSURLErrorTimedOut { why = "60秒待っても返りませんでした" }
                DispatchQueue.main.async { self?.failed(why) }
                return
            }
            DispatchQueue.main.async {
                self?.show(reading)
                self?.band.drawNowLine()
            }
        }.resume()
    }

    private func failed(_ why: String) {
        head.stringValue = "今日"
        note.stringValue = "予定を読めませんでした — \(why)"
        note.textColor = Room.now
        band.state = .unreadable
    }

    private func show(_ reading: DayReading) {
        note.textColor = Room.muted
        let today = DayBandView.today()
        let events = reading.events.filter { $0.start.hasPrefix(today) }
        let timed = events.filter { !$0.allDay && $0.start.count >= 16 }
        let allDay = events.filter { $0.allDay }
        let slots = reading.free.first(where: { $0.date == today })?.slots ?? []

        let at = Foundation.Calendar.current
        let weekday = "日月火水木金土"
        let comps = at.dateComponents([.month, .day, .weekday], from: Foundation.Date())
        let w = weekday[weekday.index(weekday.startIndex, offsetBy: (comps.weekday ?? 1) - 1)]
        head.attributedStringValue = Day.heading(
            month: comps.month ?? 0, day: comps.day ?? 0, weekday: String(w),
            ends: timed.compactMap { DayBandView.minutes($0.end ?? $0.start) }.max()
        )

        /*
         * 見出しの二行目。**空きは API の数え方に従う。**
         *
         * 帯の空白（予定と予定のあいだ）を自分で足すと、IRIS が「空き」と
         * 呼んでいるもの（短すぎる隙間を落とし、夜の窓を持つ）と数が合わない。
         * **同じ画面に二つの「空き」が出る**のがいちばん困る。
         */
        var line: [String] = []
        if let blocked = reading.blocked {
            line.append(blocked)
        } else {
            let total = slots.reduce(0) { $0 + (DayBandView.minutes($1.to + ":00") ?? 0) - (DayBandView.minutes($1.from + ":00") ?? 0) }
            line.append("予定 \(timed.count)件")
            if total > 0 { line.append("空き \(DayBandView.span(total))") }
        }
        line.append(contentsOf: allDay.map { "終日 \($0.title)" })
        note.stringValue = line.joined(separator: "　")

        band.state = .read(timed, slots)
    }

    /// 「9/9」を大きく、曜日と終わりを添えて。一つの `NSTextField` に三種の字。
    private static func heading(month: Int, day: Int, weekday: String, ends: Int?) -> NSAttributedString {
        let out = NSMutableAttributedString()
        out.append(NSAttributedString(string: "\(month)/\(day)", attributes: [
            .font: NSFont.systemFont(ofSize: 23, weight: .semibold),
            .foregroundColor: Room.ink,
        ]))
        out.append(NSAttributedString(string: "  " + weekday + "曜", attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: Room.muted,
        ]))
        if let ends {
            out.append(NSAttributedString(string: "　　\(DayBandView.clock(ends)) に終わる", attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: Room.muted,
            ]))
        }
        return out
    }
}

struct DaySlot: Decodable { let from: String; let to: String }
/**
 * この窓だけの配色。
 *
 * 出典は**部室予約 UI**（`~/Documents/Codex/room-mark7/予約UI_css.html`、
 * 利用者の指示 2026-09-09）。IRIS 本体の青（`Palette.accent` #5B9CF5）と
 * 冷たい灰（#8995A3）ではなく、あちらの**温かい白と中性の地**を使う。
 *
 * | ここ | 向こう | 意味 |
 * |---|---|---|
 * | `ink`    | `--ink` #f3f2ed    | 主たる文字。白ではなく象牙 |
 * | `muted`  | `--muted` #9a9a96  | 副次。灰も温かい側 |
 * | `label`  | `--label` #cbc9c2  | 小見出し |
 * | `ground` | `--bg` #181818     | 地。青みを持たない |
 * | `card`   | `--card` #040404   | 地より暗い面 |
 * | `action` | `--action` #0090ff | 押せる行の帯。ここでは予定の背骨 |
 * | `now`    | `--accent` #c53b31 | あちらの赤。ここでは現在時刻 |
 *
 * **レールの核の青は動かさない。**あれは IRIS の顔で、この窓の配色とは
 * 役割が違う（`Palette.accent` の注記）。ここで変えたのは**この一枚の面**。
 */
enum Room {
    static func hex(_ v: Int, _ a: CGFloat = 1) -> NSColor {
        NSColor(
            calibratedRed: CGFloat((v >> 16) & 0xFF) / 255,
            green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255,
            alpha: a
        )
    }
    static let ink = hex(0xF3F2ED)
    static let soft = hex(0xD8D6CF)
    static let muted = hex(0x9A9A96)
    static let label = hex(0xCBC9C2)
    static let ground = hex(0x181818)
    static let card = hex(0x040404)
    static let action = hex(0x0090FF)
    /// `--blue` #8aa4c8。あちらでは「楽器会」＝予定の入った時間の左線。
    static let blue = hex(0x8AA4C8)
    static let now = hex(0xC53B31)
    /// `--hairline` と `--rule`。象牙を透かしたもので、灰を混ぜたものではない。
    static let hairline = hex(0xF3F2ED, 0.10)
    static let rule = hex(0xF3F2ED, 0.22)
}

/**
 * 地。**真っ黒な箱にしない。**
 *
 * `#0C0E12` の単色は、長く開いていると面ではなく穴に見える。上から下へ
 * RGB で 5 ほどの青灰の勾配を一枚だけ載せる —— スクリーンショットでは
 * まず見えず、実機で数分開いていると「箱ではない」と分かる程度
 * （sol の助言、2026-09-09。差を大きくすると背景が主張し始める）。
 *
 * `NSVisualEffectView` は使わない。背後の壁紙を拾うと、**今日の予定の面が
 * 環境に左右される。**この窓は集中のために開くもので、下にあるものの色で
 * 表情が変わってよいものではない。
 */
final class DayGround: NSView {
    override func draw(_ dirty: NSRect) {
        // `--bg` から `--card` の側へ。青みを混ぜない（部室予約 UI の地は中性）。
        NSGradient(starting: Room.hex(0x1A1A1A), ending: Room.hex(0x151515))?.draw(in: bounds, angle: -90)
    }
}

private struct DayFree: Decodable { let date: String; let slots: [DaySlot]; let note: String? }
private struct DayReading: Decodable {
    let events: [CalendarEvent]
    let free: [DayFree]
    let blocked: String?
}

/**
 * 帯そのもの。案A「間」。
 *
 * ## 目盛りを捨てた理由
 *
 * 最初の版は 8時から24時を二時間ごとに刻んでいた。**その日に意味のある時刻は
 * 予定の始まりと終わりだけ**で、08:00 や 22:00 は誰も探していない。目盛りを
 * 引くと、何も無い夜の四時間が画面の三割を占める（実測 2026-09-09、560pt の
 * うち 20:00 以降に 168pt）。**空白に紙を割くのをやめる。**
 *
 * だから帯は**最初の予定から最後の予定まで**しか描かない。その外の空きは
 * 下に一行で畳む。縮尺は保つ（「昼が丸ごと空いている」は形で入るもので、
 * 文字で読むものではない）。
 *
 * ## 空きの数え方は一つ
 *
 * 空白の長さを自分で足さない。**`/api/schedule` の `free` をそのまま使う。**
 * 帯の空白（予定の隙間）と IRIS の言う「空き」は別物で（短い隙間は落ちる、
 * 夜の窓を持つ）、両方を同じ画面に出すと二つの数が食い違う。
 */
/// `private` ではない。**画面を開かずに絵を確かめる道具**（`tools/render-day.swift`）
/// が外から組み立てるため。実機の撮影は、画面が消えていると取れない。
final class DayBandView: NSView {
    enum State {
        case waiting
        case unreadable
        case read([CalendarEvent], [DaySlot])
    }

    var state: State = .waiting { didSet { needsDisplay = true } }

    /// いまの時刻の線が、左からどこまで伸びているか。0…1。
    private var reveal: CGFloat = 0
    private var revealTimer: Timer?

    private let rail: CGFloat = 46

    /// 画面を開かずに描くとき用。線を伸ばしきった状態にする。
    func finishRevealForRendering() { reveal = 1; needsDisplay = true }

    /// 線を一度だけ引き直す。窓を開けるたびに呼ぶ。
    func drawNowLine() {
        revealTimer?.invalidate()
        reveal = 0
        let started = Foundation.Date()
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            guard let self else { t.invalidate(); return }
            let p = min(Foundation.Date().timeIntervalSince(started) / 0.14, 1)
            // ease-out。等速だと機械が引いたように見える。
            self.reveal = CGFloat(1 - pow(1 - p, 3))
            self.needsDisplay = true
            if p >= 1 { t.invalidate(); self.revealTimer = nil }
        }
        RunLoop.main.add(timer, forMode: .common)
        revealTimer = timer
    }

    static func today() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Foundation.Date())
    }

    /// `2026-09-09T08:30` の時刻部分だけを分に。**Date に通さない** —— 壁時計の
    /// 文字列を持っているのに解釈し直すと、帯びる必要のない時間帯の問題を拾う。
    static func minutes(_ iso: String) -> Int? {
        let s = Array(iso)
        if s.count >= 16, let h = Int(String(s[11...12])), let m = Int(String(s[14...15])) {
            return h * 60 + m
        }
        // `HH:MM` そのもの（空きの端はこの形で来る）。
        if s.count >= 5, let h = Int(String(s[0...1])), let m = Int(String(s[3...4])) {
            return h * 60 + m
        }
        return nil
    }

    static func clock(_ m: Int) -> String { String(format: "%02d:%02d", m / 60, m % 60) }

    static func span(_ m: Int) -> String {
        if m < 60 { return "\(m)分" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h)時間" : "\(h)時間\(r)分"
    }

    private func text(_ s: String, _ size: CGFloat, _ color: NSColor, _ weight: NSFont.Weight = .regular) -> [NSAttributedString.Key: Any] {
        [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
    }

    /// 時刻用。**数字だけ等幅。**和文は SF のまま（`monospacedDigit` は和文を
    /// 変えない）。時刻が縦に並ぶ列なので、桁が揺れると柱が曲がって見える。
    private func digits(_ size: CGFloat, _ color: NSColor) -> [NSAttributedString.Key: Any] {
        [.font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular), .foregroundColor: color]
    }

    override func draw(_ dirty: NSRect) {
        guard case .read(let events, let slots) = state else { return }
        let timed = events.compactMap { e -> (s: Int, t: Int, title: String)? in
            guard let s = DayBandView.minutes(e.start) else { return nil }
            let t = DayBandView.minutes(e.end ?? "") ?? (s + 60)
            return (s, max(t, s + 5), e.title)
        }.sorted { $0.s < $1.s }
        guard let first = timed.first, let last = timed.map(\.t).max(), last > first.s else { return }

        let from = first.s, to = last
        // 帯の外に残った空き（たいていは夜）。畳んで下に一行。
        let after = slots.compactMap { s -> (Int, Int)? in
            guard let a = DayBandView.minutes(s.from), let b = DayBandView.minutes(s.to), a >= to else { return nil }
            return (a, b)
        }
        let foot: CGFloat = after.isEmpty ? 0 : 34
        let box = bounds.insetBy(dx: 0, dy: 6)
        let top = box.maxY, height = box.height - foot
        let y = { (m: Int) -> CGFloat in top - (CGFloat(m - from) / CGFloat(to - from)) * height }

        /*
         * ── 空きの札と、いまの時刻の線。
         *
         * 札の位置を先に決めてから線を引く。**線は札に当たるところで切る。**
         * 同じ高さに来るのは偶然ではなく、いま何もしていない時間にこの窓を
         * 開くのだから、線と「あく」の札はよく重なる（実測 2026-09-09、
         * 11:35 に開いて「2時間10分あく」の上を赤線が通った）。
         *
         * 順に描くだけでは足りない —— 後から札を描けば読めるが、線が文字を
         * 貫いた絵になる。**線の方を欠かす。**
         */
        var labels: [(text: String, at: NSPoint, size: NSSize, attrs: [NSAttributedString.Key: Any])] = []
        for s in slots {
            guard let a = DayBandView.minutes(s.from), let b = DayBandView.minutes(s.to),
                  a >= from, b <= to, b > a else { continue }
            let label = DayBandView.span(b - a) + "あく"
            let attrs = text(label, 11, Room.muted)
            let size = NSAttributedString(string: label, attributes: attrs).size()
            /*
             * 中央ではなく**次の予定寄り**に置く。
             *
             * 谷の真ん中に置くと、どちらの予定に属する空白なのかが読めない。
             * 下（＝次の予定の直前）に寄せると「ここまで空いていて、この次が
             * 始まる」と順に読める。左右は中央のまま —— 左に寄せると時刻の列と
             * 競合する。
             */
            let at = y(b) + (y(a) - y(b)) * 0.34
            labels.append((
                label,
                NSPoint(x: rail + (box.maxX - rail - size.width) / 2, y: at - size.height / 2),
                size,
                attrs
            ))
        }

        let nowM = nowMinutes()
        if nowM > from, nowM < to, reveal > 0 {
            let lineY = y(nowM)
            let end = rail + (box.maxX - rail) * reveal
            // 当たる札を避けて、線を区間に割る。
            var cuts: [(CGFloat, CGFloat)] = []
            for l in labels where abs(l.at.y + l.size.height / 2 - lineY) < l.size.height / 2 + 3 {
                cuts.append((l.at.x - 7, l.at.x + l.size.width + 7))
            }
            var x = rail
            Room.now.setStroke()
            for (a, b) in cuts.sorted(by: { $0.0 < $1.0 }) {
                if a > x {
                    let seg = NSBezierPath()
                    seg.move(to: NSPoint(x: x, y: lineY))
                    seg.line(to: NSPoint(x: min(a, end), y: lineY))
                    seg.lineWidth = 1
                    seg.stroke()
                }
                x = max(x, b)
            }
            if end > x {
                let seg = NSBezierPath()
                seg.move(to: NSPoint(x: x, y: lineY))
                seg.line(to: NSPoint(x: end, y: lineY))
                seg.lineWidth = 1
                seg.stroke()
            }
        }

        for l in labels {
            l.text.draw(at: l.at, withAttributes: l.attrs)
        }

        /*
         * ── いまの時刻。予定より先に描く（札の文字を横切らせない）。
         *
         * **この画面で唯一動くもの。**開いた瞬間に 140ms で左から伸び、あとは
         * 静止する。これが無いと「今日の記録」に見え、あると「いま参照して
         * いる今日」になる（sol、2026-09-09）。開くときの窓ごとの演出は
         * 入れない —— 一押しで出るものが、出るまでに間を持つのは邪魔。
         */

        /*
         * ── 予定。**カードではなく、時間の密度。**
         *
         * 角丸の矩形を三つ並べると「青いカードの列」に見えて、面積が時間の
         * 量を語らなくなる（sol の指摘、2026-09-09）。だから右辺を持たせず、
         * 左のアクセント線から右へ地に溶かす。**線が背骨で、面は滲み。**
         *
         * 高さの下限も外した。30pt の床を敷くと、15分の予定と1時間の予定が
         * 同じ高さになり、**縮尺を保つために目盛りを捨てた意味が消える。**
         * 短くて札が枠から溢れる場合は、溢れさせる —— その下は空白なので
         * 読めるし、面の大きさは嘘をつかない。
         */
        for e in timed {
            let hi = y(e.s), lo = y(e.t)
            let r = NSRect(x: rail, y: lo, width: box.maxX - rail, height: max(hi - lo, 3))
            /*
             * **横に溶かさない。**
             *
             * 「予定の面を左のアクセント線から地へ滲ませる」を二度試して、
             * 二度とも「右が見えにくい」と返ってきた（利用者、2026-09-09）。
             * 右の四割だけに縮めても同じ。**読みにくいなら、その案が
             * 間違っている。**面は端まで一定の濃さで持たせる。
             *
             * 「三つの同じ青いカードに見える」という元の指摘には、面の作りでは
             * なく**高さで**答える —— 下限を外してあるので、面積は時間の量に
             * 正比例し、三つの矩形は同じ形にならない。縦にごく弱い勾配だけ
             * 残す（上がわずかに明るい）。平らな塗りは板に見える。
             */
            /*
             * 参照元（部室予約 UI）の `.ev` に合わせる。あちらの CSS には
             * こう書いてある —— **「予約はカードにしない。平らに置き、左の線は
             * まっすぐ」。**
             *
             *     background: var(--card);          /* #040404 = 地より暗い */
             *     border-left: 3px solid …;
             *     border-radius: 0;
             *
             * 私は逆をやっていた（象牙を薄く敷いて地より明るくし、角を丸めた）。
             * **面は地より暗く、平ら、角は落とさない。**色を持つのは左の線だけ。
             *
             * 線は `--blue` #8aa4c8（あちらの「楽器会」＝予定の入った時間）。
             * `--action` #0090ff は使わない —— あちらの注記が
             * 「押せる行の帯。他の意味には使わない」と決めている。
             */
            Room.card.setFill()
            r.fill()
            Room.blue.setFill()
            NSRect(x: r.minX, y: r.minY, width: 3, height: r.height).fill()

            /*
             * 短い予定は、**積まずに並べる。**
             *
             * 題名の下に所要時間を置く形は、面が背より低いと下へはみ出す
             * （19:00 の1時間の予定で実際にそうなっていた、実測 2026-09-09）。
             * 高さの下限は外したままにしたいので、**札の方を畳む** —— 一行に
             * して縦中央、所要時間は同じ行の右端へ。**面から出さない。**
             */
            let titleAttrs = text(e.title, 13, Room.ink, .semibold)
            let titleH = NSAttributedString(string: e.title, attributes: titleAttrs).size().height
            let len = DayBandView.span(e.t - e.s)
            let lenAttrs = text(len, 10.5, Room.muted)
            let lenSize = NSAttributedString(string: len, attributes: lenAttrs).size()
            if r.height >= titleH + 22 {
                e.title.draw(at: NSPoint(x: r.minX + 12, y: r.maxY - titleH - 8), withAttributes: titleAttrs)
                len.draw(at: NSPoint(x: r.minX + 12, y: r.maxY - titleH - 23), withAttributes: lenAttrs)
            } else {
                let mid = r.midY - titleH / 2
                e.title.draw(at: NSPoint(x: r.minX + 12, y: mid), withAttributes: titleAttrs)
                len.draw(
                    at: NSPoint(x: r.maxX - lenSize.width - 12, y: r.midY - lenSize.height / 2),
                    withAttributes: lenAttrs
                )
            }

            // 時刻は左の列に。**始まりと終わりだけ** —— 目盛りの代わり。
            mark(DayBandView.clock(e.s), at: y(e.s), align: .top)
            mark(DayBandView.clock(e.t), at: y(e.t), align: .bottom)
        }

        if nowM > from, nowM < to, reveal >= 1 {
            Room.now.setFill()
            NSBezierPath(ovalIn: NSRect(x: rail - 9, y: y(nowM) - 3, width: 6, height: 6)).fill()
        }

        // ── 帯の外の空き。**畳むが、消さない。**
        guard let night = after.first else { return }
        let line = NSBezierPath()
        line.move(to: NSPoint(x: 0, y: box.minY + foot - 12))
        line.line(to: NSPoint(x: box.maxX, y: box.minY + foot - 12))
        Room.hairline.setStroke()
        line.lineWidth = 1
        line.stroke()
        let total = after.reduce(0) { $0 + ($1.1 - $1.0) }
        let words = "ここから \(DayBandView.span(total))、何も入っていない"
        /*
         * 時刻を書くのは、**最後の予定の終わりと違うときだけ。**
         *
         * 同じなら真上の列に既に出ていて、20:00 が縦に二つ並ぶ（実測
         * 2026-09-09）。同じ数字を二度書くのは、読む側に「別の時刻かもしれない」
         * と一瞬考えさせるぶんだけ損。
         */
        if night.0 != to {
            DayBandView.clock(night.0).draw(
                at: NSPoint(x: 4, y: box.minY + 2),
                withAttributes: digits(10.5, Room.label)
            )
        }
        words.draw(at: NSPoint(x: rail, y: box.minY + 2), withAttributes: text(words, 11, Room.muted))
    }

    private enum Align { case top, bottom }

    /// 左の列の時刻。上端の札は下へ、下端の札は上へ寄せて、枠から出さない。
    private func mark(_ s: String, at y: CGFloat, align: Align) {
        let attrs = digits(10.5, Room.label)
        let size = NSAttributedString(string: s, attributes: attrs).size()
        s.draw(at: NSPoint(x: rail - 10 - size.width, y: align == .top ? y - size.height : y), withAttributes: attrs)
    }

    private func nowMinutes() -> Int {
        let c = Foundation.Calendar.current.dateComponents([.hour, .minute], from: Foundation.Date())
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
}
