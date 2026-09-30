import AppKit

/**
 * 右端の縦レール。
 *
 * The band across the top was the first place usage went, and it was the wrong
 * place twice over. It covered the strip every application puts its tabs and
 * its close button in — clicks passed through, but a tab you cannot see is a
 * tab you cannot aim at — and it printed the figures as text, which is how a
 * session came to read `0%` as "no allowance left" and plan around avoiding an
 * agent that was completely untouched.
 *
 * A ring fills as it is spent. Empty means untouched, full means gone, and
 * nobody has to be told which way round it is.
 *
 * The right edge is free on this machine only because the Dock moved to the
 * left to make room. Top is tabs, bottom is where Claude Code keeps its model
 * switcher; right was the one side nothing else wanted.
 */

/// 一つの契約ぶん。読めないことは「0%」ではなく、そもそも輪を描かないことで表す。
struct RailEntry {
    let name: String
    let symbol: String
    /// 使った割合。`nil` は「読めない」。**0 と混ぜてはいけない。**
    let usedPercent: Int?
    /**
     * 5時間の窓の使った割合。外側の輪が週、内側がこれ。
     *
     * 週だけを輪にしていたが、**判断に効くのは短い窓の方**であることが多い
     * — 週に余裕があっても5時間が尽きれば止まる。押して札を出さないと
     * 分からないのは遠い。`nil` は読めない。
     */
    let sessionPercent: Int?
    /**
     * そもそも5時間の窓を持つ相手か。
     *
     * `sessionPercent == nil` には二つの意味がある —— **いま読めない**のと、
     * **そんな窓が無い**の。前者は待てば埋まり、後者は永久に埋まらないので、
     * 画面での扱いが違う。実測 2026-09-07: いまの Codex の契約（prolite）が
     * 書くのは週だけで、`secondary` は null。
     *
     * 契約の名前では決めない。**記録に窓があるかどうか**で決めるので、
     * 契約が変われば黙って戻る。
     */
    let hasSessionWindow: Bool
    /**
     * その値が測られてから何分経ったか。読めないときに、レールの面へ出す。
     *
     * **`—` は、壊れたのか届いていないのかを言わない。**Claude の割合は
     * 9/8 05:27 から更新されておらず、レールは二日間 `週 —` を出し続けて
     * いた。押せば理由の札が出るが、**押すまで気づかない**（実測、利用者に
     * 「ずっと表示されない」と言われるまで誰も気づかなかった）。
     *
     * 数字が出せるときは出さない。古い値が読めているかどうかは、札の
     * `note` の仕事で、面に二つ書くと面が混む。
     */
    var staleMinutes: Int? = nil
    /// 展開したときに出す窓ごとの行。
    let windows: [RailWindow]
    /// 読めないときの理由。輪の代わりに出す。
    let reason: String?
    /**
     * その道具の机上のアプリ。二度押しで前に出す。
     *
     * 読めない相手ほど効く。点線を見て「開けばいい」と分かっても、開きに
     * 行くのは別の操作だった。押す場所と、直す場所が同じになる。
     * （この形が要ったのは Gemini で、そのレーンは 2026-09-05 に外した。
     * 仕組みは残す — 次に読めない相手が出たときに要る。）
     */
    let app: String?
    /**
     * いつの値か。古いときだけ入る。
     *
     * **読めた値にも古さがある。**Claude の割合はステータス行が置いていく
     * もので、端末が動いていなければ止まる。2026-08-31、二時間前の 91% が
     * 現在の 94% の顔をして出ていた。読めたことと、いま読めたことは違う。
     */
    let note: String?
}

/**
 * レールの頭に出すもの。
 *
 * 帯を畳んだときに、帯がまだ持っていたもののうち残す価値があったのはこれだけ
 * だった — いま何をしているのかと、外の空模様。
 *
 * 試験までの日数はここには置かない。**52ポイントに入らないから**であって、
 * 要らないからではない — 数字だけ出して件名は押さないと出ない、という形に
 * 一度したが、利用者の求めは「開いた先にまとまっていること」だった。
 * ダッシュボードの予定の頭に出してある。
 *
 * 一度ここに「利用者が要らないと言った」と書き、`Shape.swift` には
 * 「利用者いわく『そこまで残したいわけではない』」と書いていた。**後者は
 * 記録のどこにも無い発言で、私が書いた。**実際には 2026-08-22 に
 * 「直近の試験までの日にちを常に出しておいてほしい」と頼まれている。
 */
struct RailHead {
    let sky: Sky
    /// 何か走っているか。印の回る速さがそのまま読みになる。
    let working: Bool
    /**
     * 押したときに出す、天気の詳しい話。
     *
     * ☁ と 27° は要約で、**要約は要約だと分かる形でしか置けない。**元の一文と、
     * いつ読んだのか、取りに行った結果なのか持っていたものなのかは、
     * 押したときに出す。
     */
    let detail: [String]
    /**
     * 予定。要約は先頭の一件、押せば数件。
     *
     * 帯を畳んでから、次の予定はダッシュボードにしか無くなった。**いちばん
     * よく見るものが、いちばん遠くにある**状態だったので、レールへ戻す。
     */
    let plans: [String]
    let nextPlan: String?
    /**
     * IRIS から話しかけて、返事を待っているもの。無ければ段ごと出さない。
     *
     * 「期限が迫っている課題がある」をレールに文字で出すことも考えたが、
     * 利用者の望みは**文字で知らされることではなく、IRIS と話すこと**
     * （2026-09-30）。だからここは知らせるだけの印で、押すとその会話が開く。
     */
    let speak: RailSpeak?
}

struct RailSpeak {
    /// `期限` など、何の話かを言う語。
    let label: String
    let conversationId: String
    /// 返事を待っている話の数。
    let count: Int
}

struct RailWindow {
    let label: String
    let usedPercent: Int?
    /// リセットまで。`6d` や `3h` のような短い形。
    let resets: String?
}

private enum Ink {
    static func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
    }
    /**
     * 不透明。0.94 をやめた。
     *
     * 盤と並べると**地の色が微妙に違って見えた** — 透けているぶん、後ろに
     * あるものでレールだけ色が動くから。同じ機械の二つの面が別の色に
     * 見えるのは、**同じ数字が二箇所にあるのと同じ種類の間違い。**
     */
    static let ground = rgb(0x0C, 0x0E, 0x12)
    static let track = rgb(0x2A, 0x2F, 0x38)
    static let label = rgb(0xE6, 0xEC, 0xF2)
    static let aside = rgb(0x89, 0x95, 0xA3)
    /**
     * 使うほど強くなる。
     *
     * 意味を持つ色で、装飾ではない。緑は「まだある」、赤は「もう無い」。
     * 帯の配色（青系）とは別扱いにする — こちらは状態を表している。
     */
    /// IRIS の印。道具の輪とは別の色で、状態を表さない。
    static let iris = rgb(0x5B, 0x9C, 0xF5)
    static func ring(_ used: Int) -> NSColor {
        // 盤と同じ三色。**同じ意味には同じ色**で、彩度は暗色向けに落として
        // ある（`docs/dark-ui-colour.md`）。
        if used >= 85 { return rgb(0xC9, 0x6D, 0x69) }
        if used >= 60 { return rgb(0xC7, 0x91, 0x5E) }
        return rgb(0x6F, 0xAF, 0x91)
    }
}

/// レール本体の描画。システムのコントロールを並べず、一つの `draw` に集める。
final class RailView: NSView {
    var entries: [RailEntry] = [] { didSet { needsDisplay = true } }

    /**
     * まだ一度も読めていない。
     *
     * **「まだ読んでいない」と「読めない」は別のこと**で、点線はそのうちの
     * 後者だけを意味する。起動直後の四十五秒、レールは点線と `—` を出して
     * いて、それは Codex が本当に読めないときと同じ顔だった — この機械が
     * いちばん避けたい形そのもの。
     *
     * 回っているものは、待てば終わると誰でも知っている。止まっている点線は
     * そうではない。三つ目の見た目が要るなら、これがいちばん短い説明。
     */
    var loading: Bool = false {
        didSet {
            guard loading != oldValue else { return }
            if loading || reloading { startSpin() } else { stopSpin() }
            needsDisplay = true
        }
    }
    /**
     * 取り直しを頼んだあいだ。
     *
     * 印だけを回していたが、**起動直後と同じ見た目にする**方が良い
     * — 利用者の指定。読み込み中の顔はこの機械に一つあれば足りるし、
     * 取り直しは実際に十数秒かかる（Claude の値は走らせないと分からない）。
     * 一瞬で終わる動作の飾りではなく、本当に待っている時間なので、
     * 待っているときの顔をそのまま使う。
     */
    var reloading: Bool = false {
        didSet {
            guard reloading != oldValue else { return }
            if reloading || loading { startSpin() } else { stopSpin() }
            needsDisplay = true
        }
    }

    /**
     * **数字を消すのは、まだ一度も読めていないときだけ。**
     *
     * 取り直しのあいだも消していた。「確かに長時間更新されてないものを残す
     * のは問題だけど、**情報をとりに行ってる間にそれを表示したままにして
     * おくのは別に問題ない**」— 利用者の言うとおりで、私が二つを混ぜていた。
     *
     * 古い値を**黙って**出し続けるのが問題なのであって、**取りに行っている
     * と分かっている十数秒**は古くない。むしろ、読めていたものが押した瞬間に
     * 消える方が、壊したように見える。
     */
    private var spinning: Bool { loading }

    private var spinner: Timer?
    private var spin: CGFloat = 0

    private func stopSpin() {
        spinner?.invalidate()
        spinner = nil
    }

    func setCoreStill(_ still: Bool) { core.animates = !still }

    private func startSpin() {
        guard spinner == nil else { return }
        // 20fps、一秒でおよそ一周。核と同じ拍。
        spinner = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.window?.occlusionState.contains(.visible) == false { return }
            self.spin += 18
            self.needsDisplay = true
        }
    }
    var selected: Int? { didSet { needsDisplay = true } }
    var onSelect: ((Int) -> Void)?

    static let itemHeight: CGFloat = 74
    /**
     * 五十二。六十二から十点削った。
     *
     * The rings were sized for a rail that also had to carry a name; it does
     * not, and the narrower it is the less of the screen edge it claims for
     * something you look at a few times a day.
     */
    static let width: CGFloat = 52
    /**
     * 三十六。三十二から広げた。
     *
     * 内側の輪（5時間）を半径 9 に置いたが、**アイコンがそこを完全に
     * 覆っていた** — 19pt の絵は 1.22 倍で描くので半径 11.6、輪の上に
     * 乗る。輪が一つに見えていたのはそのため。
     *
     * 輪を広げ、内側を外へ寄せ、絵を小さくする。三つとも動かさないと
     * 隙間が作れない。レールの幅は 52 なので、36 でも両側に 8 残る。
     */
    private let ringDiameter: CGFloat = 36

    /**
     * レールの頭。IRIS の印、空模様、状態。
     *
     * `HudShape.rail` のときだけ出す。帯を出さない代わりに、帯がまだ持って
     * いたものをここへ寄せる — 一行の文章は入らないので、印と数字にする。
     */
    var head: RailHead? {
        didSet {
            /*
             * 段の数で印の位置が変わる。**`needsDisplay` だけでは動かない**
             * — 描き直されるのは背景で、印は `NSView` なので置き直しが要る。
             */
            needsLayout = true
            core.isHidden = head == nil
            core.pace = head?.working == true ? 2.6 : 1.0
            core.brightness = head?.working == true ? 1.25 : 1.0
        }
    }
    private var headHeight: CGFloat {
        Self.headHeight(
            head: head != nil,
            sky: !(head?.sky.isEmpty ?? true),
            plan: head?.nextPlan != nil,
            speak: head?.speak != nil
        )
    }

    /**
     * 頭の段。上から**天気・時計・IRIS の印**。
     *
     * 印が一番上だった。読むもの（天気・時計・使用量）のあいだに印が挟まって
     * いる形で、**読む列が印で二つに割れていた。**印は押すもので、読むもの
     * ではない。下の輪も押すものなので、印をそちらへ寄せると、押す列と読む列
     * が分かれる（利用者、2026-09-05）。
     */
    private static let headPad: CGFloat = 8
    private static let row: CGFloat = 44
    /// 印の区画。上下に 8 ずつ空けた 36。
    private static let coreRow: CGFloat = 52

    private var skyTop: CGFloat { Self.flare + Self.headPad }
    private var planTop: CGFloat { skyTop + ((head?.sky.isEmpty ?? true) ? 0 : Self.row) }
    /// IRIS から話がある、の段。予定の下、印の上。
    private var speakTop: CGFloat { planTop + (head?.nextPlan != nil ? Self.row : 0) }
    /// 印の区画の上端。天気・時計・話の下。
    private var coreTop: CGFloat { speakTop + (head?.speak != nil ? Self.row : 0) }


    /**
     * IRIS の印は、帯と同じ核。
     *
     * アプリのアイコンを置いていたが、あれは Safari が web アプリのために
     * 自動で作った丸で、IRIS が自分で名乗っている顔ではない — 利用者いわく
     * 「簡易的すぎる」。帯にずっと出ていた核が、この機械での IRIS の顔で、
     * しかも**回る速さで状態を言う**。静止画にはできない仕事をしている。
     */
    private let core = CoreView()

    /// 下端の二つ。盤を開くのと、取り直し。
    var onBoard: (() -> Void)?
    var onReload: (() -> Void)?
    /// 二度目を待っているあいだの一度目。来たら取り消す。
    private var pendingSelect: DispatchWorkItem?
    private static let reloadHeight: CGFloat = 30

    /// 上下で縁に溶けるぶん。中身はこの内側にしか置けない。
    static let flare: CGFloat = 22

    /// 中身の高さ。窓の大きさを決めるのも、当たり判定も、これ一つから引く。
    static func headHeight(head: Bool, sky: Bool, plan: Bool = false, speak: Bool = false) -> CGFloat {
        guard head else { return 0 }
        return headPad + (sky ? row : 0) + (plan ? row : 0) + (speak ? row : 0) + coreRow
    }

    static func contentHeight(entries: Int, head: Bool, sky: Bool, plan: Bool = false, speak: Bool = false) -> CGFloat {
        let lanes: CGFloat = CGFloat(entries) * itemHeight
        let top: CGFloat = headHeight(head: head, sky: sky, plan: plan, speak: speak)
        return 6 + top + lanes + reloadHeight + 6
    }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        /**
         * 三十六。核はこの大きさで設計されている。
         *
         * 28 で置いていたが、粒が解像しないまま光だけが残り、ただの暗い丸に
         * 見えていた — 利用者いわく「全然違くない？」。帯と同じ寸法にすれば
         * 帯と同じものに見える。**この印は縮められない。**
         */
        let size: CGFloat = 36
        /**
         * 天気と時計の下。区画の上下に 8 ずつ。
         *
         * 上端に置いていたころは 16 空けていた — 輪郭が縁へ向かって溶けて
         * いく形なので、**上端は輪郭が細くなっている場所**でもあり、そこへ
         * 寄せると印の方が窮屈に見えた。いまは上に段があるので、縁の問題は
         * 無くなり、上下対称でいい。
         */
        core.frame = NSRect(
            x: (bounds.width - size) / 2, y: coreTop + (Self.coreRow - size) / 2,
            width: size, height: size
        )
        if core.superview == nil {
            addSubview(core)
            /**
             * 種を蒔いて回し始める。
             *
             * `start()` を呼ばなければ粒は一つも置かれない。描画は走るので
             * 背後の光と輪郭だけが出て、**壊れているようには見えない**
             * — 動かない核が、静かな核と同じ顔をしていた。
             */
            core.start()
        }
        core.isHidden = head == nil
    }

    /// どの項目の上か。範囲外なら nil。
    private func index(at point: NSPoint) -> Int? {
        let i = Int((point.y - Self.flare - 6 - headHeight) / Self.itemHeight)
        return i >= 0 && i < entries.count ? i : nil
    }

    /// 頭の IRIS 印を押したとき。ダッシュボードではなく IRIS そのものを開く。
    var onHead: (() -> Void)?
    /// 「IRIS から」の段を押したとき。その会話を開く。
    var onSpeak: ((String) -> Void)?
    /// 輪を二度押したとき。その道具のアプリを前に出す。
    var onOpenApp: ((String) -> Void)?

    /**
     * 押した場所と、そのときの窓の位置。
     *
     * **どこを掴んでも動かせる。**掴む場所を一箇所に決めると、その場所を
     * 覚えていないと動かせない — `⌥⌘R` が誰にも知られずに一日眠っていたのと
     * 同じ形になる。代わりに「動かしたら移動、動かさなければ押した」で
     * 分ける。押し込みの判定を `mouseUp` に移したのはそのため。
     */
    private var pressedAt: NSPoint?
    private var pressedOrigin: NSPoint?
    private var dragged = false
    /// 動かし終わったら、その位置を覚えてもらう。
    var onMoved: ((CGFloat) -> Void)?

    override func mouseDown(with event: NSEvent) {
        pressedAt = NSEvent.mouseLocation
        pressedOrigin = window?.frame.origin
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = pressedAt, let origin = pressedOrigin,
              let window, let screen = window.screen ?? NSScreen.main else { return }
        let dy = NSEvent.mouseLocation.y - start.y
        // 3ポイントまでは押し損ない。ここを超えたら移動。
        if abs(dy) > 3 { dragged = true }
        guard dragged else { return }

        /**
         * 縦だけ。**横は動かさない。**
         *
         * 右端に接していることが、この形の前提そのもの — 輪郭は縁へ向かって
         * 溶けるように描いてあって、**浮かせると溶ける先が無くなる。**
         * 上下の端も、はみ出さないところで止める。
         */
        let top = screen.visibleFrame.maxY - window.frame.height - 6
        let bottom = screen.visibleFrame.minY + 6
        let y = min(max(origin.y + dy, bottom), top)
        window.setFrameOrigin(NSPoint(x: origin.x, y: y))
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressedAt = nil; pressedOrigin = nil }
        if dragged {
            if let y = window?.frame.origin.y { onMoved?(y) }
            return
        }
        let local = convert(event.locationInWindow, from: nil)
        // 上から天気、予定、そのあとが印。無いものは押せない。
        if let head {
            if !head.sky.isEmpty, local.y < planTop { onSelect?(-1); return }
            if head.nextPlan != nil, local.y < speakTop { onSelect?(-2); return }
            if let speak = head.speak, local.y < coreTop { onSpeak?(speak.conversationId); return }
            if local.y < Self.flare + headHeight { onHead?(); return }
        }
        let lanesEnd = Self.flare + 6 + headHeight + CGFloat(entries.count) * Self.itemHeight
        if local.y >= lanesEnd {
            // 左が盤、右が取り直し。輪の当たり判定には一切触らない。
            if local.x < bounds.midX { onBoard?() } else { onReload?() }
            return
        }
        guard let i = index(at: local) else { return }

        /**
         * 一度目を、二度目が来ないと確かめてから実行する。
         *
         * 先に札を開いてから二度目でアプリを出していたので、**札が一瞬
         * 開いて閉じる**。瞬きを消すには、一度目を待たせるしかない。
         *
         * 待つのは `NSEvent.doubleClickInterval` — 系統が「二度押し」と
         * 見なす時間そのもの。**こちらで決めた値ではない**ので、利用者が
         * システム設定で速さを変えれば、そのとおりに追随する。
         *
         * 開く先を持たない輪は待たせない。待つ理由が無い。
         */
        if event.clickCount >= 2 {
            pendingSelect?.cancel()
            pendingSelect = nil
            if let app = entries[i].app { onOpenApp?(app) }
            return
        }

        guard entries[i].app != nil else { onSelect?(i); return }
        pendingSelect?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSelect = nil
            self?.onSelect?(i)
        }
        pendingSelect = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + NSEvent.doubleClickInterval, execute: work
        )
    }

    override func draw(_ dirty: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        /**
         * 上端と下端が、画面の縁へ向かって**逆向きに丸まって**溶ける。
         *
         * 角丸の長方形を右端に置くと、縁に板を立てたように見える。参考にした
         * 画面はそうではなく、レールの上下の縁が右へ行くほど持ち上がり、
         * 画面の縁と出会うところで内側に反った小さな曲線になって消えている
         * — 貼り付いたものではなく、縁から生えたものに見える理由がこれ。
         *
         * 外向きの角丸（左の二隅）と内向きの角丸（右の二隅）は、円の中心が
         * 図形の内側にあるか外側にあるかの違いでしかない。右は中心を画面の
         * 縁の上に置くので、弧は縁の側へ膨らみ、塗りはその外側に残る。
         */
        let body = NSBezierPath()
        let flare: CGFloat = 22
        let radius: CGFloat = 20
        // 四分円を三次曲線で。円弧の向きを反転で悩まずに済む。
        let k: CGFloat = 0.5523
        let box = bounds
        let top = box.minY + flare
        let bottom = box.maxY - flare

        body.move(to: NSPoint(x: box.maxX, y: box.minY))
        body.curve(
            to: NSPoint(x: box.maxX - flare, y: top),
            controlPoint1: NSPoint(x: box.maxX, y: box.minY + k * flare),
            controlPoint2: NSPoint(x: box.maxX - flare + k * flare, y: top)
        )
        body.line(to: NSPoint(x: box.minX + radius, y: top))
        body.appendArc(
            from: NSPoint(x: box.minX, y: top),
            to: NSPoint(x: box.minX, y: top + radius),
            radius: radius
        )
        body.line(to: NSPoint(x: box.minX, y: bottom - radius))
        body.appendArc(
            from: NSPoint(x: box.minX, y: bottom),
            to: NSPoint(x: box.minX + radius, y: bottom),
            radius: radius
        )
        body.line(to: NSPoint(x: box.maxX - flare, y: bottom))
        body.curve(
            to: NSPoint(x: box.maxX, y: box.maxY),
            controlPoint1: NSPoint(x: box.maxX - flare + k * flare, y: bottom),
            controlPoint2: NSPoint(x: box.maxX, y: box.maxY - k * flare)
        )
        body.close()
        Ink.ground.setFill()
        body.fill()

        if let head { drawHead(head) }

        for (i, entry) in entries.enumerated() {
            let top = Self.flare + 6 + headHeight + CGFloat(i) * Self.itemHeight
            let centre = NSPoint(x: bounds.midX, y: top + ringDiameter / 2 + 2)
            drawRing(context, at: centre, entry: entry, highlighted: selected == i)
            drawLabel(entry, at: NSPoint(x: bounds.midX, y: top + ringDiameter + 8))
        }

        /**
         * 取り直しの釦。
         *
         * Claude の割合は端末のステータス行が置いていくもので、Codex は
         * 会話の記録から読む。どちらもこちらから催促できないので、**古い**
         * ことは起こる。五分ごとの掃き直しを短くするより、見ている人が
         * 「いま」と言えた方がいい — 待つ時間を払うかどうかを、払う人が決める。
         */
        let footY = Self.flare + 6 + headHeight
            + CGFloat(entries.count) * Self.itemHeight + 4

        /**
         * 盤を開く印。輪とは別の的。
         *
         * 長押しや二度押しにはしない。レールは**見るもの**で、隠れた操作を
         * 覚えて使うものにしたくない。的が三つ（輪・盤・取り直し）あって、
         * どれも一度押すだけ、というのが覚えることの少なさそのもの。
         */
        let boardX = bounds.midX - 13
        let panel = NSBezierPath(
            roundedRect: NSRect(x: boardX - 6.5, y: footY + 3, width: 13, height: 11),
            xRadius: 2.5, yRadius: 2.5
        )
        panel.lineWidth = 1.2
        Ink.aside.setStroke()
        panel.stroke()
        Ink.aside.setFill()
        NSBezierPath(rect: NSRect(x: boardX - 4, y: footY + 7.5, width: 8, height: 1)).fill()

        let style = NSMutableParagraphStyle()
        style.alignment = .center
        let mark = NSAttributedString(string: "↻", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            .foregroundColor: reloading ? Ink.label : Ink.aside,
            .paragraphStyle: style,
        ])
        mark.draw(in: NSRect(x: bounds.midX, y: footY, width: 26, height: 18))
    }

    /**
     * 列の先頭。IRIS の印と、その下に空模様。
     *
     * 帯を畳んだぶんを「頭」として別の区画にしていたが、罫と状態の点が付いた
     * ぶん、レールの上にもう一つ小さな装置が乗っているように見えていた
     * — 利用者いわく「上の方はいらないかも」。区画をやめて、**天気も列の中に
     * 一つの項目として並べる**。輪が無いだけで、置き方は道具と同じ。
     *
     * IRIS の印は押せる。ダッシュボードではなく IRIS のページを開く。
     */
    private func drawHead(_ head: RailHead) {
        // 印そのものは `core` が描く。ここは天気と予定。
        if !head.sky.isEmpty {
            if let name = head.sky.symbol,
               let icon = Sky.image(name, size: 15, weight: .regular, colour: Ink.label) {
                icon.draw(in: NSRect(
                    x: (bounds.width - icon.size.width) / 2, y: skyTop + 4,
                    width: icon.size.width, height: icon.size.height
                ))
            } else if let word = head.sky.word {
                // 印に無い空模様。**語のまま出す。**空欄にはしない。
                centred(word, y: skyTop + 4, size: 10, colour: Ink.label, weight: .medium)
            }
            if let degrees = head.sky.degrees {
                centred(degrees, y: skyTop + 22, size: 11, colour: Ink.aside, weight: .medium)
            }
        }

        /**
         * 次の予定は、時刻だけ。
         *
         * 52 ポイントの幅に件名は入らない。**入らないものを縮めて入れると、
         * 読めない字が並ぶだけで、読めた気にさせる。**時刻なら入るし、
         * 押せば件名が出る。
         */
        if let next = head.nextPlan {
            centred("◷", y: planTop + 2, size: 14, colour: Ink.label)
            centred(next, y: planTop + 22, size: 11, colour: Ink.aside, weight: .medium)
        }

        /**
         * IRIS から話がある。印は IRIS の色で、**レールで唯一こちらから呼んでいる段。**
         *
         * 文面は出さない（入らない）。何の話かの語と、二件以上なら数。
         * 押すとその会話が開く。
         */
        if let speak = head.speak {
            if let icon = Sky.image("text.bubble.fill", size: 15, weight: .regular, colour: Ink.iris) {
                icon.draw(in: NSRect(
                    x: (bounds.width - icon.size.width) / 2, y: speakTop + 4,
                    width: icon.size.width, height: icon.size.height
                ))
            }
            let word = speak.count > 1 ? "\(speak.label) \(speak.count)" : speak.label
            centred(word, y: speakTop + 22, size: 11, colour: Ink.iris, weight: .semibold)
        }

    }

    private func centred(
        _ text: String, y: CGFloat, size: CGFloat, colour: NSColor,
        weight: NSFont.Weight = .regular
    ) {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: colour,
            .paragraphStyle: style,
        ]).draw(in: NSRect(x: 0, y: y, width: bounds.width, height: size + 6))
    }

    /// 回っている短い弧。満ちる向きと同じ向きに回す。
    private func travelling(_ centre: NSPoint, radius: CGFloat, width: CGFloat) {
        let arc = NSBezierPath()
        arc.appendArc(
            withCenter: centre, radius: radius,
            startAngle: 270 + spin, endAngle: 270 + spin + 70, clockwise: false
        )
        arc.lineWidth = width
        arc.lineCapStyle = .round
        Ink.aside.setStroke()
        arc.stroke()
    }

    private func drawRing(_ context: CGContext, at centre: NSPoint, entry: RailEntry, highlighted: Bool) {
        let radius = ringDiameter / 2

        let track = NSBezierPath()
        track.appendArc(withCenter: centre, radius: radius, startAngle: 0, endAngle: 360)
        track.lineWidth = 3

        if spinning {
            /**
             * track の上を短い弧が回る。
             *
             * 満ちる向き（12時から時計回り）と同じ向きに回す。あとで本当の
             * 弧が出たときに、同じものが止まったように見える。
             */
            Ink.track.setStroke()
            track.stroke()
            let arc = NSBezierPath()
            arc.appendArc(
                withCenter: centre, radius: radius,
                startAngle: 270 + spin, endAngle: 270 + spin + 80, clockwise: false
            )
            arc.lineWidth = 3
            arc.lineCapStyle = .round
            Ink.aside.setStroke()
            arc.stroke()
            drawGlyph(entry.symbol, at: centre, dimmed: true)
            return
        }

        guard let used = entry.usedPercent else {
            /**
             * 読めないものは輪を描かない。
             *
             * 空の輪にすると「まだ使っていない」に見える。2026-08-28 に
             * まさにその読み違えが起き、手つかずの Codex を避ける計画が立った。
             * **0% と「読めない」は別の見た目でなければならない。**
             */
            Ink.track.setStroke()
            track.setLineDash([2, 3], count: 2, phase: 0)
            track.stroke()
            if reloading { travelling(centre, radius: radius + 4.5, width: 1.5) }
            drawGlyph(entry.symbol, at: centre, dimmed: true)
            return
        }

        /**
         * 外が5時間、内が週。**入れ替えた。**
         *
         * 週を外に置いていたが、**止めに来るのは短い方**で、働いている午後に
         * 動くのもそちら。目に先に入る場所は、先に効く方に譲る。
         *
         * 外側は5時間が読めるときだけ描く。読めないのに軌道だけ置くと
         * 「手つかず」に見えるので、そのときは週の輪ひとつになる。
         */
        /*
         * **輪は一本。あるなら5時間、無ければ週。**
         *
         * 週の輪は一度やめた（下の注記）。理由は「5時間の輪が既にあるのに
         * 二本目を置くとアイコンが半径 10 まで削られる」で、**二本目である
         * ことが問題**だった。5時間の窓を持たない相手では輪が一本も無く、
         * 位置は空いたまま —— Codex がそれで、数字だけの段になっていた
         * （利用者、2026-09-10「codexも週間だけになったなら週間使用量を
         * claudeみたいにアイコンの周りに書いてよ」）。
         *
         * 空いている位置に一本入れるのは、二本目を足すのとは別の話。
         * アイコンは削られないし、**壁が近いことを色で言う場所**が段ごとに
         * 揃う。
         */
        let ringValue = entry.sessionPercent ?? used
        Ink.track.setStroke()
        track.stroke()
        if ringValue > 0 {
            let arc = NSBezierPath()
            arc.appendArc(
                withCenter: centre, radius: radius,
                startAngle: 270, endAngle: 270 + 360 * CGFloat(min(ringValue, 100)) / 100,
                clockwise: false
            )
            arc.lineWidth = 3
            arc.lineCapStyle = .round
            Ink.ring(ringValue).setStroke()
            arc.stroke()
        }

        // 取りに行っているあいだ、輪の外を弧が一周する。読みには触れない。
        if reloading { travelling(centre, radius: radius + 4.5, width: 1.5) }

        /**
         * 内側の輪はやめた。**輪は一本まで。**
         *
         * （この注記は「週は数字だけ」と決めたときのもの。いまは輪が一本も
         * 無い段でだけ週を輪にする —— 上の分岐。禁じたかったのは二本目で、
         * 空いた位置ではない。）
         *
         * 週は日単位でしか動かないので、**一日眺めていて弧が伸びることは
         * ない** — 形が区別していないなら、それは装飾。そして輪を二本置くと
         * アイコンが半径 10 まで削られ、**何の道具か分かりにくくなっていた**
         * （利用者いわく「機能は良くなったけど視認性は下がった」）。
         *
         * 輪にしかできていなかったのは「壁が近いか」を色で言うことだけ
         * なので、それは下の数字が引き継ぐ。**失うものは無い。**
         */
        _ = used
        drawGlyph(entry.symbol, at: centre, dimmed: false)
    }

    /**
     * その道具のアイコンそのもの。
     *
     * 記号で代用していたが、Claude も Codex も見て分かるアイコンを持っている
     * — 利用者の言葉で「こんなマークじゃなくない？」。並んでいるのはどれも
     * デスクトップアプリのある道具なので、そのアプリの顔をそのまま使う。
     *
     * 色は落とさない。参考にした画面もそうしているし、三つ並んだときに
     * 見分けるのは形より色が早い。読めない相手だけは薄くして、輪の点線と
     * 合わせる。
     */
    /**
     * 二十四。輪の内側いっぱいまで。
     *
     * 19 では輪の中に余白が三分の一ほど残り、**何のアイコンか分かる前に
     * 「小さい丸」として通り過ぎる。**三つ並んだときに見分けるのは形と色で、
     * どちらも大きさが要る。輪の太さ 3 を引いた内径は 29 なので、24 は
     * 触れずに収まるいちばん大きい寸法。
     */
    private func drawGlyph(
        _ name: String, at centre: NSPoint, dimmed: Bool, size: CGFloat = 24
    ) {
        let box = NSRect(x: centre.x - size / 2, y: centre.y - size / 2, width: size, height: size)
        if let image = bundledIcon(name) {
            /**
             * 丸く抜く。
             *
             * デスクトップのアイコンをそのまま置くと、角丸の四角いタイルごと
             * 貼り付いて、輪の中に別の作品が一つ入っているように見える
             * — 利用者いわく「デスクトップアイコンごとくり抜いてる」。
             * 円で抜けば色は残り、形は輪と揃う。
             */
            /**
             * 円で抜き、**画のほうを一回り大きく描く。**
             *
             * 抜くだけでは足りなかった。macOS のアプリアイコンは画像いっぱいに
             * 描かれておらず、角丸のタイルの周りに透明な余白がある（規格では
             * 幅の約 82%）。同じ大きさの円で抜いても、円はその余白を切るだけで
             * タイルの角には届かない — だから丸くしたつもりで四角いままだった。
             *
             * タイルの幅が円の直径と揃うところまで拡大してから抜く。角は円の
             * 外へ出て落ち、中身の大きさは今までと変わらない。
             */
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(ovalIn: box).addClip()
            let overdraw = box.insetBy(dx: -box.width * 0.11, dy: -box.height * 0.11)
            image.draw(in: overdraw, from: .zero, operation: .sourceOver, fraction: dimmed ? 0.45 : 1)
            NSGraphicsContext.restoreGraphicsState()
            return
        }
        // アイコンが入っていない場合に何も出ないより、頭文字だけでも出す。
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        NSAttributedString(string: String(name.prefix(1)), attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: dimmed ? Ink.aside : Ink.label,
            .paragraphStyle: style,
        ]).draw(in: NSRect(x: box.minX, y: box.minY + 2, width: size, height: size))
    }

    private var iconCache: [String: NSImage] = [:]

    private func bundledIcon(_ name: String) -> NSImage? {
        if let cached = iconCache[name] { return cached }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        iconCache[name] = image
        return image
    }

    /**
     * 二つの窓の数字。**どちらがどちらか、語で言う。**
     *
     * 週だけを出していたので、輪が二重でも**読みでは一つ**だった。そして
     * 週が 6%、5時間が 60% のような組み合わせだと、**外の弧は細い筋にしか
     * ならず、内の弧と見分けが付かない** — 数字が無いと二重に見えない、
     * という利用者の指摘はそのとおり。
     *
     * `週` と `5h` を付けるのは、`6% · 60%` では**どちらがどちらか
     * 分からない**から。順番で覚えさせない。
     */
    private func drawLabel(_ entry: RailEntry, at point: NSPoint) {
        // 読み込み中に `—` を出すと「読めなかった」と読める。何も出さない。
        guard !spinning else { return }

        func line(_ label: String, _ value: Int?, at y: CGFloat, strong: Bool, state: Bool = false) {
            let style = NSMutableParagraphStyle()
            style.alignment = .center
            let text = value.map { "\(label) \($0)%" } ?? "\(label) —"
            /**
             * 週の数字は状態の色を持つ。
             *
             * 内側の輪をやめたので、**「壁が近いか」を言うものが他に無い。**
             * 91% と 7% が同じ見た目だと、輪を外したぶんが本当に失われる。
             * 色は既に意味に予約してある三色で、新しくは増やさない。
             */
            let colour: NSColor
            if value == nil { colour = Ink.aside }
            else if state, let value { colour = Ink.ring(value) }
            else { colour = strong ? Ink.label : Ink.aside }
            NSAttributedString(string: text, attributes: [
                .font: NSFont.monospacedDigitSystemFont(
                    ofSize: strong ? 10 : 9, weight: strong ? .medium : .regular
                ),
                .foregroundColor: colour,
                .paragraphStyle: style,
            ]).draw(in: NSRect(x: point.x - 26, y: y, width: 52, height: 13))
        }

        /**
         * 太字は5時間。**輪の主従と揃える。**
         *
         * 輪の外側を5時間にしたのに、数字は週が太字のままだった
         * — **同じものの主従を、二つの場所が違うように言っていた。**
         * どちらも語が付いているので取り違えは起きないが、揃っていない
         * ことに理由が無い。
         *
         * 読めない5時間も `—` を出す。**黙って行ごと消さない** — 消して
         * いたので、Claude に二行あって Codex に一行という画面になり、
         * なぜ片方に無いのかが分からなかった。**出せないことは出せる。**
         *
         * 週そのものが読めないものは、週の一行だけ。そこに二つ目の `—` は
         * 要らない。
         */
        if entry.usedPercent != nil && entry.hasSessionWindow {
            line("5h", entry.sessionPercent, at: point.y, strong: true)
            line("週", entry.usedPercent, at: point.y + 13, strong: false, state: true)
        } else {
            /*
             * 5時間の窓を持たない相手は、週の一行だけ。
             *
             * ここは前まで `5h —` を出していた。**読めないことは出せる**と
             * いう理屈で、それ自体は正しい。だが「読めない」と「無い」は
             * 別のことで、無い窓に `—` を置くと、**待てば埋まるものに見える。**
             * 永久に埋まらない行は、読み飛ばす行になる。
             */
            line("週", entry.usedPercent, at: point.y, strong: true, state: true)
        }

        /*
         * 読めないときだけ、いつの値かを面に出す。
         *
         * `—` の下に一行ぶんの余地がある —— 二行出すのは数字が読める段で、
         * そのときはここへ来ない。段の高さ（74）には触らないので、隣の段は
         * 動かない。
         */
        guard entry.usedPercent == nil, let stale = briefAge(entry.staleMinutes) else { return }
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        NSAttributedString(string: stale, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 8, weight: .regular),
            .foregroundColor: Ink.aside.withAlphaComponent(0.7),
            .paragraphStyle: style,
        ]).draw(in: NSRect(x: point.x - 26, y: point.y + 13, width: 52, height: 11))
    }
}

/// 面に載る長さの経過。札の `age` は文なので、52pt には入らない。
private func briefAge(_ minutes: Int?) -> String? {
    guard let minutes, minutes > 30 else { return nil }
    if minutes < 120 { return "\(minutes)分前" }
    if minutes < 60 * 48 { return "\(minutes / 60)時間前" }
    return "\(minutes / 60 / 24)日前"
}

/// 札に出すもの。棒の並びでも、文だけでもいい。
struct RailCard {
    let title: String
    let windows: [RailWindow]
    /**
     * 読ませたい中身。**本文の色で出す。**
     *
     * 全部を添え字の色にしていたので、**名札（「天気」）がいちばん明るく、
     * 読みたい文がいちばん暗かった** — 階層が逆になっていた。
     * 明るさは読みやすさではなく、**どれを先に読むか**を言っている。
     */
    let lead: [String]
    /// いつの値か、なぜ読めないか。**付帯情報は添え字の色。**
    let notes: [String]
}

/// 押したときに左へ出るカード。窓ごとの内訳と、添える文。
final class RailCardView: NSView {
    var card: RailCard? { didSet { needsDisplay = true } }

    /**
     * 328。300 では右端が切れていた。
     *
     * 中身は左から 16、札 74、棒 116、割合 44、リセットまで 34 と余白で、
     * 足すと 312 になる。300 のままリセットの列だけが窓の外に出ていて、
     * 「2d」が「2」に見えていた — 切れた数字は、間違った数字と同じくらい悪い。
     */
    static let width: CGFloat = 328

    /**
     * 中身に合わせた幅。
     *
     * 328 は棒の並びのために要る寸法で、文しか無い札には広すぎた
     * — 右側が大きく空いて、**何かが入るはずの場所が空いている**ように
     * 見える。文だけの札は、いちばん長い行に合わせて詰める。
     */
    static func width(for card: RailCard) -> CGFloat {
        guard card.windows.isEmpty else { return width }
        let longest = (card.lead + card.notes).reduce(CGFloat(0)) { widest, line in
            max(widest, NSString(string: line).size(
                withAttributes: [.font: NSFont.systemFont(ofSize: 12)]
            ).width)
        }
        let title = NSString(string: card.title).size(
            withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)]
        ).width
        return min(max(max(longest, title) + 32, 180), width)
    }
    static func height(for card: RailCard) -> CGFloat {
        let bars = CGFloat(card.windows.count) * 26
        let room = width(for: card)
        let lead = card.lead.reduce(CGFloat(0)) { $0 + lineHeight($1, in: room, size: 12) }
        let notes = card.notes.reduce(CGFloat(0)) { $0 + lineHeight($1, in: room, size: 10) }
        let gap: CGFloat = (card.notes.isEmpty || card.lead.isEmpty) ? 0 : 10
        return 38 + bars + lead + gap + notes + 16
    }

    /// 折り返したときの高さ。**切らずに全部出す** — 一文が長いことがある。
    /**
     * 行間は段落の設定で決める。**足し算の余白ではなく。**
     *
     * 高さを測って 7 ポイント足していたので、**一行なら間が空きすぎ、
     * 二行なら行同士がくっつく** — 折り返しの中の行間には何も効いて
     * いなかった。1.35 は日本語の本文で自然に見える値。
     */
    static func paragraphStyle() -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.lineHeightMultiple = 1.35
        return style
    }

    static func lineHeight(_ text: String, in room: CGFloat, size: CGFloat = 11) -> CGFloat {
        let box = NSString(string: text).boundingRect(
            with: NSSize(width: room - 32, height: 200),
            options: [.usesLineFragmentOrigin],
            attributes: [
                .font: NSFont.systemFont(ofSize: size),
                .paragraphStyle: paragraphStyle(),
            ]
        )
        return ceil(box.height) + 2
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirty: NSRect) {
        guard let card else { return }
        let body = NSBezierPath(roundedRect: bounds, xRadius: 14, yRadius: 14)
        Ink.ground.setFill()
        body.fill()

        /**
         * 名札は明るく、ただし小さく。
         *
         * 添え字の色にしていたら、**下の「最終更新」と同じ濃さになって
         * しまい、名札と付帯情報が同じ階層に見えた。**明るさを本文と揃え、
         * 大きさで中身に譲る — 小さく明るい語は、その下にあるものの名前
         * として読まれる。
         */
        draw(card.title, at: NSPoint(x: 16, y: 12), size: 10, weight: .semibold, colour: Ink.label)

        var y: CGFloat = 38
        for window in card.windows {
            draw(window.label, at: NSPoint(x: 16, y: y), size: 11, colour: Ink.aside, width: 74)

            let barX: CGFloat = 96
            let barWidth: CGFloat = 116
            let track = NSBezierPath(
                roundedRect: NSRect(x: barX, y: y + 4, width: barWidth, height: 6),
                xRadius: 3, yRadius: 3
            )
            Ink.track.setFill()
            track.fill()

            if let used = window.usedPercent, used > 0 {
                let filled = max(4, barWidth * CGFloat(min(used, 100)) / 100)
                let bar = NSBezierPath(
                    roundedRect: NSRect(x: barX, y: y + 4, width: filled, height: 6),
                    xRadius: 3, yRadius: 3
                )
                Ink.ring(used).setFill()
                bar.fill()
            }

            // 「<1%」は 0 と違う。使っていないのではなく、少しだけ使っている。
            let figure = window.usedPercent.map { $0 == 0 ? "0%" : "\($0)%" } ?? "—"
            draw(figure, at: NSPoint(x: barX + barWidth + 10, y: y - 1), size: 11,
                 colour: window.usedPercent == nil ? Ink.aside : Ink.label, width: 44, align: .right)

            if let resets = window.resets {
                draw(resets, at: NSPoint(x: barX + barWidth + 58, y: y - 1), size: 11,
                     colour: Ink.aside, width: 34, align: .right)
            }
            y += 26
        }

        func paragraph(_ line: String, size: CGFloat, colour: NSColor) {
            let height = Self.lineHeight(line, in: bounds.width, size: size)
            NSAttributedString(string: line, attributes: [
                .font: NSFont.systemFont(ofSize: size),
                .foregroundColor: colour,
                .paragraphStyle: Self.paragraphStyle(),
            ]).draw(in: NSRect(x: 16, y: y, width: bounds.width - 32, height: height))
            y += height
        }
        for line in card.lead { paragraph(line, size: 12, colour: Ink.label) }
        /**
         * 付帯情報は、中身から離す。
         *
         * 「天気」と「最終更新」が同じ濃さ・同じ間隔で並んでいたので、
         * **名札と付帯情報が同じ階層に見えていた。**離して、暗くして、
         * 小さくする — 三つ揃えないと階層は立たない。
         */
        if !card.notes.isEmpty && !card.lead.isEmpty { y += 10 }
        for line in card.notes { paragraph(line, size: 10, colour: Ink.aside) }
    }

    private func draw(
        _ text: String, at point: NSPoint, size: CGFloat,
        weight: NSFont.Weight = .regular, colour: NSColor,
        width: CGFloat = 200, align: NSTextAlignment = .left
    ) {
        let style = NSMutableParagraphStyle()
        style.alignment = align
        style.lineBreakMode = .byTruncatingTail
        let string = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: colour,
            .paragraphStyle: style,
        ])
        string.draw(in: NSRect(x: point.x, y: point.y, width: width, height: size + 6))
    }
}

/// レールの窓。右辺に貼り付き、押すとカードが左へ出る。
final class Rail: NSPanel {
    /// 上下にずらした位置。次に出したときも同じ高さに置く。
    static let placeKey = "railY"

    private let view = RailView()
    private var card: NSPanel?
    private var cardView = RailCardView()

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
        /**
         * 窓の既定の移動は切る。
         *
         * `RailView` が縦だけ動かしていて、そこに系統の移動が重なると
         * **横にも動いて、縁から浮く。**動かし方は一つでいい。
         */
        isMovable = false
        appearance = NSAppearance(named: .darkAqua)
        contentView = view

        view.onSelect = { [weak self] index in self?.toggleCard(index) }
        view.onMoved = { [weak self] y in
            UserDefaults.standard.set(Double(y), forKey: Rail.placeKey)
            // 札が開いていれば一緒に連れていく。置いていくと、どの輪の札か
            // 分からないものが宙に残る。
            if let self, let index = self.view.selected { self.placeCard(index) }
        }
    }

    /// 頭を出すかどうか。形が `.rail` のときだけ中身が入る。
    var onHead: (() -> Void)? {
        get { view.onHead }
        set { view.onHead = newValue }
    }

    /// 「IRIS から」の段を押したとき。
    var onSpeak: ((String) -> Void)? {
        get { view.onSpeak }
        set { view.onSpeak = newValue }
    }

    /// 輪を二度押したとき。
    var onOpenApp: ((String) -> Void)? {
        get { view.onOpenApp }
        set { view.onOpenApp = newValue }
    }

    /// 下端の二つ。
    var onBoard: (() -> Void)? {
        get { view.onBoard }
        set { view.onBoard = newValue }
    }

    var onReload: (() -> Void)? {
        get { view.onReload }
        set { view.onReload = newValue }
    }

    /// 核を止める・動かす。設定は帯ではなく核に効く。
    func setCoreStill(_ still: Bool) { view.setCoreStill(still) }

    /// 頼んだ、と見せる。解くのは、値が新しくなったと分かった側。
    func beginReload() { view.reloading = true }
    func endReload() { view.reloading = false }

    func show(_ entries: [RailEntry], head: RailHead? = nil, loading: Bool = false) {
        view.loading = loading
        view.head = head
        view.entries = entries
        guard let screen = NSScreen.main else { return }
        let height = RailView.contentHeight(
            entries: entries.count,
            head: head != nil,
            sky: !(head?.sky.isEmpty ?? true),
            plan: head?.nextPlan != nil,
            speak: head?.speak != nil
        ) + RailView.flare * 2
        /**
         * 右辺の、覚えている高さ。無ければ縦中央。
         *
         * **横は動かさない。**右端に接していることがこの形の前提で、輪郭は
         * その縁へ向かって溶けるように描いてある。上下だけずらせれば、
         * 「いま邪魔なもの」からは十分に避けられる — 隠すのに毎回コマンドを
         * 叩くよりも軽い。
         *
         * 画面が変わると覚えた位置が画面外になることがある。**そのときは
         * 中央へ戻す** — 見えない場所にある窓は、無いのと同じ。
         */
        let top = screen.visibleFrame.maxY - height - 6
        let bottom = screen.visibleFrame.minY + 6
        let saved = UserDefaults.standard.object(forKey: Rail.placeKey) as? Double
        let wanted = saved.map { CGFloat($0) } ?? screen.frame.midY - height / 2
        let frame = NSRect(
            x: screen.frame.maxX - RailView.width,
            y: bottom <= top ? min(max(wanted, bottom), top) : bottom,
            width: RailView.width, height: height
        )
        setFrame(frame, display: true)
        orderFrontRegardless()
        if let index = view.selected, index < entries.count { placeCard(index) }
    }

    private func toggleCard(_ index: Int) {
        if view.selected == index {
            view.selected = nil
            card?.orderOut(nil)
            card = nil
            return
        }
        view.selected = index
        placeCard(index)
    }

    /**
     * `-1` は天気。
     *
     * 天気は道具ではないので `entries` に並べていないが、押したときに出す
     * ものがある点では同じ。番号を一つだけ外へ伸ばして、札の仕組みを
     * 二つ持たずに済ませる。
     */
    private func placeCard(_ index: Int) {
        let content: RailCard
        if index == -2 {
            guard let head = view.head else { return }
            // 予定はどれも中身。付帯情報は無い。
            /*
             * 予定の札に、打ち込む口の案内を添える。
             *
             * レールは 52 ポイントしか無いので、そこに三つ目の押し場所は
             * 置けない。**押した先の札には幅がある**ので、案内はここに置く。
             * 札は表示だけなので、押させるのではなく打鍵を教える。
             */
            content = RailCard(
                title: "予定",
                windows: [],
                lead: head.plans,
                notes: ["⌥⌘N で予定を打ち込む"]
            )
        } else if index < 0 {
            guard let head = view.head else { return }
            /**
             * 一行目が空模様そのもので、残りは「いつの値か」。
             * **読ませたいのは一行目**なので、そこだけ本文の色。
             */
            content = RailCard(
                title: "天気", windows: [],
                lead: Array(head.detail.prefix(1)), notes: Array(head.detail.dropFirst())
            )
        } else {
            guard index < view.entries.count else { return }
            let entry = view.entries[index]
            // 使用量は棒が中身。文はどれも付帯情報。
            content = RailCard(
                title: entry.name,
                windows: entry.windows,
                lead: [],
                notes: [entry.note, entry.reason].compactMap { $0 }
            )
        }
        cardView.card = content

        let panel = card ?? {
            let p = NSPanel(
                contentRect: .zero,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false
            )
            p.level = level
            p.collectionBehavior = collectionBehavior
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.isFloatingPanel = true
            p.hidesOnDeactivate = false
            p.appearance = NSAppearance(named: .darkAqua)
            p.contentView = cardView
            card = p
            return p
        }()

        let height = RailCardView.height(for: content)
        let room = RailCardView.width(for: content)
        let headPart = RailView.headHeight(
            head: view.head != nil,
            sky: !(view.head?.sky.isEmpty ?? true),
            plan: view.head?.nextPlan != nil,
            speak: view.head?.speak != nil
        )
        let top: CGFloat
        if index < 0 {
            /*
             * 頭の札は、押した段のところに出す。
             *
             * 一つだったころは頭の中ほどで足りたが、段が三つになると
             * **どれを押しても同じ高さに出る**ことになり、出ている札が
             * どれの話なのか分からなくなる。段の位置から引く。
             */
            let sky = !(view.head?.sky.isEmpty ?? true)
            let offset: CGFloat = index == -1 ? 8 + 22 : 8 + (sky ? 44 : 0) + 22
            top = frame.maxY - RailView.flare - 6 - offset
        } else {
            top = frame.maxY - RailView.flare - 6 - headPart
                - CGFloat(index) * RailView.itemHeight - RailView.itemHeight / 2
        }
        panel.setFrame(
            NSRect(
                x: frame.minX - room - 8,
                y: min(max(top - height / 2, 20), (NSScreen.main?.frame.maxY ?? 900) - height - 20),
                width: room, height: height
            ),
            display: true
        )
        panel.orderFrontRegardless()
    }

    /// 帯を閉じるときと同じで、カードも一緒に引っ込める。
    func hide() {
        card?.orderOut(nil)
        card = nil
        view.selected = nil
        orderOut(nil)
    }
}

/**
 * 契約の読みを、レールに出せる形へ。
 *
 * 読めないものは `usedPercent: nil` として渡す。**0 にしてはいけない** — 空の輪は
 * 「まだ使っていない」に見え、それがこの表示を作るきっかけになった読み違えそのもの。
 */
/// 「N分前の値です」。新しいうちは何も言わない — 常に出ていると読まれなくなる。
private func age(_ minutes: Int?, from limit: Int = 30) -> String? {
    guard let minutes, minutes > limit else { return nil }
    if minutes < 120 { return "この値は \(minutes) 分前のものです" }
    return "この値は \(minutes / 60) 時間前のものです"
}

/// エポックミリ秒から、いま何分前か。無ければ何も言わない。
private func minutesSince(_ ms: Double?) -> Int? {
    guard let ms else { return nil }
    let seconds = Date().timeIntervalSince1970 - ms / 1000
    return seconds > 0 ? Int(seconds / 60) : 0
}

func railEntries(from usage: CliUsage?) -> [RailEntry] {
    func resets(_ ms: Double?) -> String? {
        guard let ms else { return nil }
        let seconds = ms / 1000 - Date().timeIntervalSince1970
        if seconds <= 0 { return nil }
        let hours = Int(seconds / 3600)
        return hours >= 24 ? "\(hours / 24)d" : "\(max(hours, 1))h"
    }

    let claudeWeek = usage?.claudeLimits?.week
    let claudeSession = usage?.claudeLimits?.session
    let claude = RailEntry(
        name: "Claude",
        symbol: "Claude",
        usedPercent: claudeWeek?.usedPercent,
        sessionPercent: claudeSession?.usedPercent,
        // Claude の枠は常に5時間と週の二本立て。読めない日はあっても、窓は在る。
        hasSessionWindow: true,
        staleMinutes: usage?.claudeLimits?.ageMinutes,
        windows: [
            RailWindow(label: "週", usedPercent: claudeWeek?.usedPercent, resets: resets(claudeWeek?.resetsAtMs)),
            RailWindow(label: "5時間", usedPercent: claudeSession?.usedPercent, resets: resets(claudeSession?.resetsAtMs)),
        ],
        reason: claudeWeek == nil
            ? (usage?.claudeLimits?.reason ?? "ステータス行がまだ届いていません。")
            : nil,
        app: "/Applications/Claude.app",
        /**
         * 三十分より古ければ、いつの値か言う。
         *
         * この値だけは端末が動いていないと止まる。止まっていることは、
         * 数字の見た目からは分からない。
         */
        note: age(usage?.claudeLimits?.ageMinutes)
    )

    /**
     * その窓は、まだ生きているか。
     *
     * リセット時刻が過ぎている読みは、**その窓のものではない。**Codex の
     * 5時間の窓は 08/31 07:03 にリセットされていて、画面はその前に記録された
     * 1% を、いまの5時間ぶんとして出し続けていた。0% かもしれないし 40%
     * かもしれない — **分からない、が正しい答え。**
     */
    func current(_ resetsAtMs: Double?) -> Bool {
        guard let resetsAtMs else { return false }
        return resetsAtMs / 1000 > Date().timeIntervalSince1970
    }

    let codexWeek = usage?.codex
    let codexSession = usage?.codex?.session
    let sessionLive = current(codexSession?.resetsAtMs)
    let codex = RailEntry(
        name: "Codex",
        symbol: "Codex",
        usedPercent: codexWeek?.usedPercent,
        sessionPercent: sessionLive ? codexSession?.usedPercent : nil,
        // 記録に短い窓が書かれていたかどうか。契約の名前では決めない。
        hasSessionWindow: codexSession != nil,
        staleMinutes: minutesSince(codexWeek?.recordedAtMs),
        /*
         * 5時間の段は、**その窓が実在するときだけ**出す。
         *
         * いまの契約（実測 2026-09-07: prolite）が書くのは週だけで、
         * `secondary` は null —— 5時間の窓が無い。無い窓の段を置くと、
         * **永久に空欄の行**になる。空欄の行は、読み飛ばす行になる。
         *
         * 消すのではなく畳む。契約が変わって5時間が戻れば、記録に窓が
         * 現れた時点でこの段も戻る。**契約の名前で分岐していないので、
         * 名前が変わっても続く。**
         */
        windows: [
            RailWindow(label: "週", usedPercent: codexWeek?.usedPercent, resets: resets(codexWeek?.resetsAtMs)),
        ] + (codexSession == nil
            ? []
            : [
                RailWindow(
                    label: "5時間",
                    usedPercent: sessionLive ? codexSession?.usedPercent : nil,
                    resets: resets(codexSession?.resetsAtMs)
                ),
            ]),
        /*
         * 空欄には、なぜ空欄かを添える。
         *
         * 記録そのものが無いのか、5時間の窓が入れ替わったのか —— **どちらも
         * 見た目は同じ**なので言わないと区別できない。
         *
         * 「その契約に5時間の窓が無い」は、ここには出さない。**段ごと畳んで
         * あるので、説明する空欄がもう無い。**言えば、無いものを待っている
         * ように読める。
         */
        reason: codexWeek == nil
            ? (usage?.codexReason ?? "Codex の記録が見つかりません。")
            : (codexSession != nil && !sessionLive
                ? "5時間の窓は入れ替わりました。次に Codex を動かすまで分かりません。"
                : nil),
        // Codex の枠は ChatGPT の契約。アイコンもあちらの中のもの。
        app: "/Applications/ChatGPT.app",
        /**
         * いつの読みか。
         *
         * Codex の値は会話の記録から読むので、**Codex を動かしていない
         * あいだは何時間でも古くなる。**古いこと自体は問題ではないが、
         * 古いことが見えないのは問題。
         */
        note: age(minutesSince(usage?.codex?.recordedAtMs))
    )

    /*
     * Gemini（agy）はレーンに出さない。**使っていないから**（利用者、
     * 2026-09-05）。
     *
     * 読み取りそのものは止めていない — `/api/usage/cli` は今も agy の値を
     * 返し、ブリーフィングもそれを読む。**見せる場所を減らしただけで、
     * 分かっていることを捨てたのではない。**この二つを混同すると、次に
     * 「読めないのか、出していないだけなのか」で迷うことになる。
     *
     * 読み口は `RetrieveUserQuotaSummary`（文書化されていない口）で、
     * 消える日が来たら点線に戻るだけ。**もっともらしい数字にはならない。**
     */
    return [claude, codex]
}
