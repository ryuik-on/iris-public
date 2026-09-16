import AppKit

/**
 * 帯の形。
 *
 * The band began as a strip across the whole top, which is where a machine
 * puts the thing it wants read first and also where every application keeps
 * its tabs. Now that the usage figures have moved to the rail, what is left
 * is small enough to ask whether it needs the width at all.
 *
 * Three shapes, switchable while it runs, because the way to settle this is to
 * live with each of them rather than to argue about a screenshot.
 */
/**
 * 上端いっぱいの帯は無くなった。
 *
 * タブの列を覆っていて、畳んだあとも `⌥⌘B` で戻せる状態にしていた
 * — 利用者いわく「完全に出ないようにして」。**戻せる形で残っているものは、
 * 事故で戻る。**選択肢から外せば、戻る道が無くなる。
 *
 * `Strip` の実装はファイルに残してある。ノッチが上端の窓の書き方を借りて
 * いて、次に上端へ何か出すときの出発点でもあるので。**出す口だけを外す。**
 */
enum HudShape: String {
    /// 中央に短く。文章が一行入る。
    case notch
    /// 帯を出さず、右のレールの上に集約する。
    case rail

    private static let key = "hudShape"

    static var current: HudShape {
        // 以前の設定に `band` が残っていることがある。**復活させない。**
        HudShape(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .rail
    }

    static func set(_ shape: HudShape) {
        UserDefaults.standard.set(shape.rawValue, forKey: key)
    }

    var next: HudShape { self == .notch ? .rail : .notch }

    var label: String { self == .notch ? "ノッチ" : "レール" }
}

/**
 * 天気の一行を、印と温度に分ける。
 *
 * 「今日の気温は28℃、曇り時々晴れです。」が入ってくる。ノッチにもレールにも
 * 一行は入らないので、読むのに要るところだけ取り出す。
 *
 * **見つからなかったものは作らない。**温度が読めなければ温度は出さないし、
 * 空模様の語が一つも無ければ印も出さない。存在しない天気を絵文字で
 * それらしく見せるのは、この機械でいちばん避けたい失敗の形そのもの。
 */
struct Sky {
    /**
     * 空模様の印。**SF Symbols の名前**であって、絵文字ではない。
     *
     * 絵文字を使っていたが、2026-09-05 に霧雨の日、レールに白い四角が出た。
     * 測ると字が無いのではなく、**Apple の 🌫️ がほぼ塗り潰しの帯で**、
     * 15pt・黒地では四角にしか見えなかった（点灯 20.2%、他の印は 10% 前後、
     * 字が無いときの豆腐が 7.1%）。**描けているのに読めない**という壊れ方。
     *
     * 加えて、絵文字はこのレールで唯一の色付きの物体だった。記号なら単色で、
     * 周りの線と同じ太さに揃う。
     */
    let symbol: String?
    let degrees: String?
    /**
     * 印に直せなかったときの、空模様の語そのもの。
     *
     * 2026-09-01、予報が「今日の気温は27℃、**強風**です。」を返した。表に
     * 風が無かったので印は付かず、**画面には温度だけが残った。**印が無い
     * ことと、空模様が分からないことは別で、**分かっているものを出さない
     * のは、無いものを作るのと同じくらい悪い。**
     *
     * 表を増やしても、次に来る語は読めない。だから**表に無ければ語を出す。**
     */
    let word: String?

    var isEmpty: Bool { symbol == nil && word == nil && degrees == nil }

    /**
     * 記号を、指定の色で塗った絵にする。
     *
     * 記号は雛形（template）なので、描いてから `sourceAtop` で塗る。塗らずに
     * 描くと**何も出ない** — 測って分かったことで、見た目には
     * 「印が無い日」と区別が付かない。
     *
     * 名前が引けなければ `nil`。呼ぶ側は語に落とす。**空白は返さない。**
     */
    static func image(_ name: String, size: CGFloat, weight: NSFont.Weight, colour: NSColor) -> NSImage? {
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
              let sized = base.withSymbolConfiguration(.init(pointSize: size, weight: weight))
        else { return nil }
        return NSImage(size: sized.size, flipped: false) { rect in
            sized.draw(in: rect)
            colour.set()
            rect.fill(using: .sourceAtop)
            return true
        }
    }

    /**
     * 語の優先順ではなく、**文の中で先に出てきた方**を採る。
     *
     * 「曇り時々晴れ」は曇りで、「晴れ時々曇り」は晴れ。日本語の天気は主たる
     * 空模様を先に言うので、位置がそのまま重みになっている。
     */
    private static let marks: [(String, String)] = [
        ("雷", "cloud.bolt.rain.fill"), ("雪", "snowflake"), ("雨", "cloud.rain.fill"),
        ("霧", "cloud.fog.fill"), ("風", "wind"), ("曇", "cloud.fill"), ("晴", "sun.max.fill"),
    ]

    init(_ text: String?) {
        guard let text, !text.isEmpty else {
            symbol = nil
            degrees = nil
            word = nil
            return
        }

        var found: (Int, String)?
        for (word, symbol) in Self.marks {
            guard let range = text.range(of: word) else { continue }
            let at = text.distance(from: text.startIndex, to: range.lowerBound)
            if found == nil || at < found!.0 { found = (at, symbol) }
        }
        symbol = found?.1

        /**
         * 「、」と「です」のあいだが空模様。予報はこの形で返ってくる。
         *
         * 印が付いても取っておく。**記号が引けなかったときの落としどころ**が
         * 要るから — 引けなかった日に空白を出すのは、その日だけ天気が無かった
         * ように見える。
         */
        if let comma = text.range(of: "、"),
           let tail = text.range(of: "です", range: comma.upperBound..<text.endIndex) {
            let phrase = String(text[comma.upperBound..<tail.lowerBound])
            word = phrase.isEmpty ? nil : String(phrase.prefix(4))
        } else {
            word = nil
        }

        // 「28℃」も「28度」も来る。数字だけ抜いて、単位はこちらで揃える。
        var digits = ""
        var reading = false
        for character in text {
            if character.isNumber { digits.append(character); reading = true; continue }
            if reading {
                if character == "℃" || character == "度" { break }
                digits = ""
                reading = false
            }
        }
        degrees = digits.isEmpty ? nil : "\(digits)°"
    }
}

/**
 * 中央のノッチ。
 *
 * 帯の三分の一の幅で、置き場所は上端の中央 — タブは左に寄るので、ここは
 * どの応用でも空いている。中身は帯から絞った：状態の一言と、空模様と温度。
 * 試験までの日数はここには入らない。幅が足りないだけで、要らないからでは
 * ない — レールの頭には出してある。以前ここに「利用者いわく『そこまで残し
 * たいわけではない』」と書いていたが、**その発言は記録のどこにも無い。**
 *
 * 組み立てではなく描画。三つの部品を制約で並べると、幅が変わるたびに
 * 崩れ方を考えることになる。
 */
final class NotchView: NSView {
    var status: String = "" { didSet { needsDisplay = true } }
    var tone: NSColor = Palette.Band.headline { didSet { needsDisplay = true } }
    var sky = Sky(nil) { didSet { needsDisplay = true } }

    static let size = NSSize(width: 296, height: 32)

    override var isFlipped: Bool { true }

    override func draw(_ dirty: NSRect) {
        // 上端は画面の縁なので丸めない。下の二隅だけ落とす。
        let radius: CGFloat = 14
        let box = bounds
        let body = NSBezierPath()
        body.move(to: NSPoint(x: box.minX, y: box.minY))
        body.line(to: NSPoint(x: box.minX, y: box.maxY - radius))
        body.appendArc(
            from: NSPoint(x: box.minX, y: box.maxY),
            to: NSPoint(x: box.minX + radius, y: box.maxY),
            radius: radius
        )
        body.line(to: NSPoint(x: box.maxX - radius, y: box.maxY))
        body.appendArc(
            from: NSPoint(x: box.maxX, y: box.maxY),
            to: NSPoint(x: box.maxX, y: box.maxY - radius),
            radius: radius
        )
        body.line(to: NSPoint(x: box.maxX, y: box.minY))
        body.close()
        Palette.Band.ground.setFill()
        body.fill()

        // 右端から先に置く。温度は桁が変わるので、左に伸びる方が揺れない。
        var right = box.maxX - 14
        if let degrees = sky.degrees {
            right -= write(degrees, rightEdgeAt: right, size: 12, colour: Palette.Band.emphasis)
        }
        if let name = sky.symbol,
           let icon = Sky.image(name, size: 13, weight: .regular, colour: Palette.Band.emphasis) {
            right -= 4
            let at = NSRect(
                x: right - icon.size.width, y: box.midY - icon.size.height / 2,
                width: icon.size.width, height: icon.size.height
            )
            icon.draw(in: at)
            right -= icon.size.width
        } else if let word = sky.word {
            // 記号が引けなかった日。**空白にはしない。**
            right -= 4
            right -= write(word, rightEdgeAt: right, size: 12, colour: Palette.Band.emphasis)
        }

        // 状態は左から。空模様にぶつかる手前で切る。
        let left = box.minX + 44
        let room = max(0, right - 10 - left)
        write(status, leftEdgeAt: left, width: room, size: 12, colour: tone)
    }

    @discardableResult
    private func write(
        _ text: String, leftEdgeAt x: CGFloat, width: CGFloat,
        size: CGFloat, colour: NSColor
    ) -> CGFloat {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let string = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: .medium),
            .foregroundColor: colour,
            .paragraphStyle: style,
        ])
        string.draw(in: NSRect(x: x, y: (bounds.height - size) / 2 - 2, width: width, height: size + 6))
        return min(width, string.size().width)
    }

    @discardableResult
    private func write(
        _ text: String, rightEdgeAt x: CGFloat, size: CGFloat, colour: NSColor
    ) -> CGFloat {
        let string = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: .medium),
            .foregroundColor: colour,
        ])
        let width = string.size().width
        string.draw(in: NSRect(
            x: x - width, y: (bounds.height - size) / 2 - 2, width: width, height: size + 6
        ))
        return width
    }
}

/**
 * ノッチの窓。
 *
 * 帯とは別の窓にした。帯の中で部品を隠して作り替えると、帯が自前で持っている
 * 「この行は今は出さない」という判断（天気が読めない、など）と取り合いになり、
 * 形を戻したときにどれを出すはずだったのかが分からなくなる。別の窓なら、
 * 出す・出さないは一箇所で済む。
 */
final class Notch: NSPanel {
    var onPress: (() -> Void)?
    private let view = NotchView()

    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isFloatingPanel = true
        hidesOnDeactivate = false
        appearance = NSAppearance(named: .darkAqua)
        contentView = view
    }

    override var canBecomeKey: Bool { false }

    override func mouseDown(with event: NSEvent) { onPress?() }

    func show(_ snapshot: Snapshot) {
        let l = lines(for: snapshot)
        view.status = l.headline
        view.tone = l.wantsAttention ? Palette.attention : Palette.Band.headline
        if case let .ready(all) = snapshot {
            view.sky = Sky(all.weather?.text)
        } else {
            view.sky = Sky(nil)
        }
        place()
        orderFrontRegardless()
    }

    /// 上端の中央。タブは左に寄るので、ここはどの応用でも空いている。
    func place() {
        guard let screen = NSScreen.main else { return }
        let full = screen.frame
        let visible = screen.visibleFrame
        let size = NotchView.size
        setFrame(
            NSRect(
                x: full.midX - size.width / 2,
                y: visible.maxY - size.height,
                width: size.width, height: size.height
            ),
            display: true
        )
    }
}
