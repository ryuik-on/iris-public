import AppKit
import Carbon.HIToolbox
import Foundation
// CGImageSource（コアの絵を束から読む）のため。
import ImageIO

/**
 * IRIS in the menu bar.
 *
 * The reason this exists is one sentence the user wrote: they open a chat
 * client to check how far along their work is, while studying. That is a
 * context switch to answer a question that fits in a dozen characters, and it
 * happens several times a day.
 *
 * So this is deliberately not a small copy of the app. It is one line that is
 * always there, and a menu that opens when the line is not enough. Nothing
 * here composes, edits, or sends anything.
 *
 * Everything it shows comes from IRIS's own HTTP surface on loopback, which is
 * trusted without a token — the same rule the server applies. No credentials
 * live here, and there is nothing to configure.
 */

// MARK: - What IRIS reports

struct Progress: Decodable {
    let total: Int
    let done: Int
    let blocked: Int
    let inProgress: Int
    let todo: Int
    /// Statuses the ledger could not read. Never folded into the others.
    let unknown: Int
}

struct LedgerTask: Decodable {
    let id: String?
    let title: String
    let status: String
    let notes: String
    /// When the ledger last recorded anything about it, as `yyyy-MM-dd`.
    let updated: String?
    /// Task ids this one is waiting on. The ledger's own answer to "why not yet".
    let dependsOn: [String]?
}

struct LedgerProject: Decodable {
    let id: String?
    let name: String
    let status: String
    let priority: String
    let progress: Progress
    let tasks: [LedgerTask]
}

struct WatchedRepo: Decodable {
    let name: String
    let lastCommit: String?
    let registered: Bool
}

struct Portfolio: Decodable {
    let ok: Bool
    let source: String
    let reason: String?
    let projects: [LedgerProject]?
    let repos: [WatchedRepo]?
    let warnings: [String]?
}

struct AgentRun: Decodable {
    let id: String
    let agent: String?
    let branch: String
    let state: String
    /// When it started, so the band can say how long it has been going.
    let startedAt: String?
    /// Kept for the record. Not displayed: see the running headline.
    let usd: Double?
    /// What the run has actually spent.
    let outputTokens: Int?
    let stopReason: String?
}

/**
 * Development runs the server considers stuck.
 *
 * A different thing from a delegated coding run. These report progress and
 * are judged stalled when they stop reporting; a delegated run has no such
 * signal and simply stays `running` until its deadline, which is why both
 * are asked about.
 */
/**
 * Where the week went, and whether anyone could audit it.
 *
 * Both were built and neither was shown. The band carries a total — CLAUDE
 * 90% — and nothing said which of six projects spent it; the review service
 * could report whether an independent reviewer exists at all, and the first
 * anyone would learn that none does is a review that refuses.
 */
struct AllowanceBreakdown: Decodable {
    struct Project: Decodable {
        let project: String
        let weightedUsd: Double
        let sharePercent: Double
    }
    struct Estimate: Decodable {
        let project: String
        let estimatedWeekPoints: Double
    }
    let byProject: [Project]
    let estimatedWeekPoints: [Estimate]?
    let pricingLastVerified: String?
}

struct ReviewCapability: Decodable {
    struct Reviewer: Decodable {
        let id: String
        let vendor: String
        let model: String
    }
    let canReview: Bool
    let implementerModel: String?
    let availableReviewers: [Reviewer]
}

struct StalledRuns: Decodable {
    let runs: [StalledRun]
}

struct StalledRun: Decodable {
    let id: String
    let agent: String?
}

struct AgentRuns: Decodable {
    let runs: [AgentRun]
}

struct PendingApproval: Decodable {
    let sessionId: String
    let toolName: String
    let riskLevel: String
    /// What this call does, in a sentence. Absent when the tool cannot say.
    let summary: String?
}

struct Approvals: Decodable {
    let pendingApprovals: [PendingApproval]
}

/**
 * 先回りの提案。
 *
 * 長いあいだ `id` しか読んでいなかった —— 盤は**数えるだけ**で、中身を出す
 * 相手がいなかったから。IRIS の側から声をかけるようになって、**何を言うか**が
 * 要るようになった（`Notify.swift`）。
 */
struct Suggestion: Decodable {
    let id: String?
    /// 規則の文。通知の表題になる。
    let suggestion: String?
    /// なぜ言うのか。通知の本文になる —— 件数では動けないのは通知でも同じ。
    let because: [SuggestionBecause]?
}

/**
 * 提案の根拠ひとつ。
 *
 * `value` は文字列にも、文字列の配列にも、数にもなる（観測の種類ごとに違う）。
 * **読めない形を推測で埋めない** —— 読めた形だけを行にして、残りは捨てる。
 */
struct SuggestionBecause: Decodable {
    let kind: String?
    /// 表示に使える行。読めなければ空。
    let valueLines: [String]

    private enum CodingKeys: String, CodingKey { case kind, value }

    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        kind = try? box.decode(String.self, forKey: .kind)
        if let many = try? box.decode([String].self, forKey: .value) {
            valueLines = many
        } else if let one = try? box.decode(String.self, forKey: .value) {
            valueLines = [one]
        } else if let number = try? box.decode(Double.self, forKey: .value) {
            valueLines = [String(format: number == number.rounded() ? "%.0f" : "%g", number)]
        } else {
            valueLines = []
        }
    }
}

struct Proactive: Decodable {
    let pending: [Suggestion]
}

struct CalendarEvent: Decodable {
    let title: String
    /// Local wall time, `2026-08-21T14:30`. Not parsed into a Date: the strip
    /// shows the clock time it was given, and reparsing invites a zone bug.
    let start: String
    /**
     * 終わり。**無い予定がある。**
     *
     * 「明日の授業が何時に終わるのか分からない」（利用者、2026-09-09）。
     * 札には始まりしか出ていなかった —— 始まりだけ見せて、いつ空くのかは
     * 別の場所で調べさせていた。値はサーバが前から返している。
     *
     * `nil` は「終わりが書かれていない予定」で、**0分でも当日いっぱいでも
     * ない。**そのときは始まりだけ出す。
     */
    let end: String?
    let allDay: Bool
}

struct Calendar: Decodable {
    let events: [CalendarEvent]
}

/// Everything the strip needs, in one value.
struct BudgetWindow: Decodable {
    let window: String
    let spentUsd: Double?
    let limitUsd: Double?
}

struct Budget: Decodable {
    let windows: [BudgetWindow]
}

struct Session: Decodable {
    let id: String
    /// Claude が自分に付けている名前。`iris-70` のような。無いこともある。
    let name: String?
    /// その処理がまだ生きているか。閉じた窓は、待っているのではなく終わっている。
    let live: Bool?
    /// 人が読める作業名。Claude 自身の画面に出ている名前。無いことがある。
    let work: String?
    /// 最後に頼まれたこと。**いま何をしているか**にいちばん近い観測。
    let doingNow: String?
    /// 再開に使う丸ごとの id。`id` は画面用に切ってあるので使えない。
    let resume: String?
    let kind: String
    let place: String
    let title: String?
    let idleMinutes: Int
    /**
     * Minutes the turn in flight has been running, or nothing when idle.
     *
     * `idleMinutes` is zero while an agent is mid-answer — which is exactly
     * when somebody wants to know how long they have been waiting, so it says
     * nothing at the one moment it matters.
     */
    let busyMinutes: Int?
    let turns: Int
    let doing: String
    let background: Int
}

struct Sessions: Decodable {
    let sessions: [Session]
    let unreadable: Int
}

/**
 * The forecast, or the reason there isn't one.
 *
 * `reason` is not decoration. macOS will not hand the weather over directly,
 * so this comes through a Shortcut the user made by hand — which means the
 * ordinary failure is "the shortcut is gone", not "the sky is unknown". A
 * blank corner where the weather was would read as the second, and be the
 * first, and go unnoticed for as long as it took someone to wonder.
 */
struct Weather: Decodable {
    let text: String?
    let reason: String?
    /// いつ読んだか。ISO8601。
    let at: String?
    /// 取りに行かず、持っていたものを出したか。
    let cached: Bool?
    /// 最後に読めた値を出しているか。**現在の空模様ではない。**
    let stale: Bool?
    /// その値の古さ。`stale` のときだけ入る。
    let ageMinutes: Int?
}

/**
 * The road to the next appointment, when there is one worth asking about.
 *
 * Almost always empty, and that is correct: the server only measures inside
 * three hours of an event it can place, which is the only window where the
 * answer is both knowable and wanted.
 */
/**
 * Where the next appointment is, when it is close enough to matter.
 *
 * The server answers only the part that needs the calendar and the place map.
 * How long the road takes is measured here, by `Travel`, because that needs a
 * location and a location permission belongs to an application bundle.
 */
struct Destination: Decodable {
    /// The address to route to, or nothing when the title is not a place.
    let to: String?
    let label: String?
    let minutesUntil: Int?
    let reason: String?
    /// Titles this machine can resolve to a place. See `name(_:)`.
    let knownPlaces: [String]?
}

/**
 * What is left of each assistant's allowance.
 *
 * Two sources that arrive by completely different routes and are drawn the
 * same. Codex writes its own limits into every session rollout, so that
 * figure is read from disk. Claude's is not on disk at all — it is relayed by
 * a status-line hook and is only as fresh as the last time Claude Code drew
 * one, which is why `ageMinutes` travels with it.
 */
struct LimitBand: Decodable {
    let usedPercent: Int
    let resetsAtMs: Double?
}

struct ClaudeLimits: Decodable {
    let session: LimitBand?
    let week: LimitBand?
    let ageMinutes: Int?
    let reason: String?
}

/// 同じ記録に入っている短い方の窓。週と取り違えないよう、別の型で持つ。
struct CodexWindow: Decodable {
    let usedPercent: Int
    let resetsAtMs: Double?
    let windowMinutes: Int
}

struct CodexUsage: Decodable {
    let usedPercent: Int
    let resetsAtMs: Double?
    let windowMinutes: Int
    let session: CodexWindow?
    /// この読みが記録された時刻。**いつの値かは、値と同じくらい要る。**
    let recordedAtMs: Double?
}

struct CliUsage: Decodable {
    let codex: CodexUsage?
    let codexReason: String?
    let claudeLimits: ClaudeLimits?
    let agy: AgyReading?
}

/**
 * Antigravity の残量。
 *
 * 三つのうちで唯一、相手のアプリが動いていないと読めない。読めないことは
 * `quota` が無いことで表し、`reason` にその理由が入る — 0% は書かない。
 */
struct AgyReading: Decodable {
    let quota: AgyQuota?
    let reason: String?
    /// **いま取れた値ではない。**Antigravity が閉じているあいだの、最後の値。
    let stale: Bool?
    let ageMinutes: Int?
}

struct AgyQuota: Decodable {
    let gemini: AgyGroup?
}

struct AgyGroup: Decodable {
    let week: AgyWindow?
    let session: AgyWindow?
}

/// **使った割合。**契約側は残量で返すが、サーバがここへ渡す前に反転している。
struct AgyWindow: Decodable {
    let usedPercent: Int
    let resetsAtMs: Double?
}

/**
 * Whether the work is anywhere but this disk.
 *
 * Reported so that failure is visible. A backup that has stopped writes
 * nothing, and nothing on screen is indistinguishable from a backup that is
 * working — which is the shape of failure this whole project is named after.
 */
/**
 * The next exam, kept on screen whether or not it has changed.
 *
 * Almost everything on the band earns its place by changing. This does not,
 * and that is the reason for it: nobody looks up an exam date on the day it
 * stops being far away.
 */
/**
 * FDP の課題台帳。
 *
 * `ok: false` のとき `tasks` は**存在しない** — 空配列ではない。0件と
 * 「読めなかった」を同じ形にしないのは、この機械の決まりで、口の側もそう
 * 作られている（iris-70 が固定してある）。
 */
struct FdpTasks: Decodable {
    let ok: Bool
    let tasks: [FdpTask]?
    let doneCount: Int?
    let settings: FdpSettings?
    let error: String?
}

struct FdpTask: Decodable {
    let id: String
    let title: String
    let priority: String?
    let status: String?
    /// 完了 / 順調 / 更新停止 / 遅延。**シートが計算した値をそのまま運ぶ。**
    let verdict: String?
    let due: String?
    /// 期限まで何日。**サーバ側で確定した基準時刻から引いてある。**
    let dueInDays: Int?
    /// 最終更新から何日。`更新停止` の正体はこの数字。
    let stillDays: Int?
    /// 開始予定まで何日。負なら、もう始まっているはずのもの。
    let startsInDays: Int?
    /// 開始予定日。`2026/11/03`。
    let start: String?
    /**
     * 意図して止めている期限。`2026-10-20`。
     *
     * **理由ではなく日付を必須にしたのが要点。**理由は期限切れしないので、
     * 「後回し」と書いた課題は半年後も保留のままになり、**保留が黙って忘却に
     * 変わる。**日付はその日が来れば効かなくなり、普通に判定され直す。
     */
    let heldUntil: String?
    let heldUntilInDays: Int?
    let holdReason: String?
    let nextAction: String?
}

/// 台帳側の閾値。**画面に焼き込まない** — シートで変えれば追随する。
struct FdpSettings: Decodable {
    let stalledAfterDays: Int?
}

/**
 * IRIS に委任した仕事の台帳。
 *
 * `/api/portfolio` とは別の台帳で、**盤もレールもこれを読んでいなかった。**
 * 2026-09-02 に利用者が「5日くらい放置してる気がする」と言って発覚した
 * — 実際には42件が積まれ、うち5件は14日前から `in_progress` のままで、
 * 完了は0件だった。**記録はあったのに、記録を見る場所が無かった。**
 */
struct DevTasks: Decodable {
    let tasks: [DevTask]
}

struct DevTask: Decodable {
    let id: String
    let title: String
    /// 依頼したときの言葉。作業内容として出す。
    let goal: String?
    let status: String
    let createdAt: String?
    /// いま走っている実行。0は「いま動いていない」で、**手付かずではない。**
    let activeRuns: Int?
    /**
     * これまでに走った回数。
     *
     * `activeRuns` だけを見て「未着手」と書いていた。**二度走って止まって
     * いるものが、一度も触っていないものと同じ語になっていた**（実測
     * 2026-09-07、盤に並ぶ5件はすべて 1〜2回走ったあと 8月18日から放置）。
     * 同じ「20日」でも、次にやることが違う。
     */
    let runCount: Int?
}

/**
 * 今日の一件ずつと、残っている時間。`/api/focus`。
 *
 * 分野ごとに一件（試験・研究・改善・OS・仕事・コンペ）と、直近の予定。
 * **400行かけて選んでいるのに、どの画面も読んでいなかった**（2026-09-08、
 * 独立レビューを追いかけて分かった）。呼ぶ口はここが最初。
 */
struct Focus: Decodable {
    let date: String?
    let items: [FocusItem]
    let examMode: Bool?
    let daysToExam: Int?
    /// 源が読めなかった分野。**空欄を「何も無い」と読ませないため。**
    let unavailable: [String]?
    let room: FocusRoom?
}

struct FocusItem: Decodable {
    let area: String
    let label: String?
    /// その分野の一件。`null` は「この分野には本当に無い」。
    let title: String?
    let due: String?
    let detail: String?
    /// 源が読めたか。`false` のとき `title` の空欄は「無い」ではない。
    let available: Bool?
}

/**
 * いまから今日の終わりまでに残っている時間。
 *
 * `longestMinutes` が `nil` は**「言えない」**、`0` は**「もう無い」**。
 * 画面ではどちらも同じに見えるので、**混ぜない。**
 */
struct FocusRoom: Decodable {
    let longestMinutes: Int?
    let totalMinutes: Int?
    let reason: String?
    let summary: String?
}

/**
 * 講義日程表とカレンダーの食い違い。`/api/lectures/divergence`。
 *
 * 「明日は8:30から授業あると思うんだけど」（利用者、2026-09-08）。日程表は
 * 1限＝08:30、カレンダーは 09:40 だった。**気づいたのは本人の記憶。**
 */
struct LectureDivergence: Decodable {
    let compared: Bool
    let reason: String?
    let moved: [LectureGap]
    let missing: [LectureGap]
    /**
     * カレンダーにあって日程表に無い（別の日の複製など）。
     *
     * 古いサーバは返さないので省略可。無ければ空 —— 「余分なし」ではなく
     * 「その検査をしていない」だが、盤の印は付かないだけなので害は無い。
     */
    let surplus: [LectureGap]?
    /**
     * 紙と暦で日付が違う（前後3日以内）。
     *
     * 盤は暦の行に印を付けるので、**暦にある側の日付で引く。**古いサーバは
     * 返さないので省略可。
     */
    let shifted: [LectureGap]?
}

struct LectureGap: Decodable {
    let title: String
    /**
     * 授業か試験か。**印の文字を変えるため。**
     *
     * 「日程表に無い」は授業なら入れ間違い程度だが、試験だと日を間違えて
     * 勉強していることになる。古いサーバは返さないので省略可 —— 無ければ
     * 授業として扱う。
     */
    let kind: String?
    let date: String
    let period: Int?
    /// 日程表の時刻。
    let scheduled: String?
    /// カレンダーの時刻。欠けているときは nil。
    let calendar: String?
}

struct NextExam: Decodable {
    let title: String
    let date: String
    let days: Int
    let after: Int
    /**
     * 暦ではなく、**印刷された講義日程表**から答えたときだけ入る。
     *
     * 日程表には版があり、刷ったあとに動く。暦の方が新しいので、これが
     * 入っているのは「暦が何も言わなかった」場合。**出どころの違いは、
     * 日付と同じ大きさの事実**なので、盤にもそのまま出す。
     */
    let from: String?
}

struct RepoBackup: Decodable {
    let branch: String?
    let unpushed: Int?
    let lastPushAt: String?
    let lastError: String?
}

/// What the band ends up saying about the road, if anything.
struct Road {
    let minutes: Int?
    let reason: String?
}

struct Everything {
    let portfolio: Portfolio
    let runs: [AgentRun]
    let approvals: Int
    let pending: [PendingApproval]
    let suggestions: Int
    /**
     * 提案そのもの。数だけでは声をかけられない。
     *
     * 盤は長らく数えるだけだった（出す相手がいなかったので）。IRIS の側から
     * 声をかけるようになって、**何を言うか**が要るようになった。
     */
    let suggestionList: [Suggestion]
    /**
     * Everything in range, not only the next one.
     *
     * The band says what is left today *and* what tomorrow opens with, which
     * needs two of them; picking the nearest in the reader threw away the
     * other before anyone could ask for it.
     */
    let events: [CalendarEvent]
    let budget: Budget?
    let sessions: [Session]
    let weather: Weather?
    /// Calendar titles that name somewhere this machine knows how to reach.
    let places: [String]
    let exam: NextExam?
    let road: Road?
    let usage: CliUsage?
    let backup: RepoBackup?
    let fdp: FdpTasks?
    let dev: [DevTask]?
    let stalledRuns: Int
    let breakdown: AllowanceBreakdown?
    let review: ReviewCapability?
    let focus: Focus?
    let lectures: LectureDivergence?
}

/**
 * What the menu bar is currently able to say.
 *
 * `unreachable` is a case of its own rather than an empty snapshot. A row of
 * zeroes is indistinguishable from a quiet week, and this whole project exists
 * because that distinction kept getting lost.
 */
enum Snapshot {
    case unreachable(String)
    case unreadable(String)
    case ready(Everything)
}

// MARK: - Reading it

final class Reader {
    private let session: URLSession

    /**
     * The breakdown, fetched on its own slow clock.
     *
     * It reads several hundred transcripts and takes tens of seconds, which
     * is far too long for a forty-five second poll to wait on — and its
     * window is a rolling seven days, so nothing in it changes meaningfully
     * between one glance and the next. Kept from the last successful read and
     * refreshed in the background every fifteen minutes.
     */
    private var breakdownCache: AllowanceBreakdown?
    private var breakdownAt: Date?
    var breakdown: AllowanceBreakdown? { breakdownCache }

    /**
     * FDP の課題も、同じく遅い時計で。
     *
     * 台帳は Google のシートを経由するので、45秒の巡回に相乗りさせると
     * **他の全部がシートの機嫌に付き合うことになる。**課題は分単位で
     * 変わるものでもない。
     */
    private var fdpCache: FdpTasks?
    private var fdpAt: Date?
    var fdp: FdpTasks? { fdpCache }

    /// 委任した仕事。分単位で変わるものではないので、こちらも遅い時計で。
    private var devCache: [DevTask]?
    private var devAt: Date?
    var dev: [DevTask]? { devCache }

    /*
     * `/api/focus` は表とカレンダーを読むので、返るまで十秒かかることがある。
     * **連なった取得の中に入れると、盤ぜんたいがそれを待つ。**別に、遅れて
     * 足す（`dev` と同じ形）。
     */
    private var focusCache: Focus?
    private var focusAt: Date?
    var focus: Focus? { focusCache }

    /// 日程表との食い違い。予定の行に添えるので、`Everything` に載せる。
    private var lecturesCache: LectureDivergence?
    private var lecturesAt: Date?
    var lectures: LectureDivergence? { lecturesCache }

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        // Loopback only. This never talks to anything else.
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        session = URLSession(configuration: config)
    }

    /**
     * One pass over everything the strip says.
     *
     * The portfolio decides whether there is a snapshot at all: if it cannot be
     * reached the strip says so, and if the ledger cannot be read the strip
     * says that instead. The other four are secondary — a missing calendar is
     * a line the strip omits, not a reason to stop reporting the rest. Each
     * degrades to nothing rather than taking the whole snapshot down.
     *
     * Nested rather than concurrent. Five requests to loopback cost a few
     * milliseconds, and the sequence keeps the failure rule in one place
     * instead of spread across a dispatch group.
     */
    func read(_ done: @escaping (Snapshot) -> Void) {
        refreshBreakdownIfStale()
        refreshFdpIfStale()
        refreshDevIfStale()
        refreshFocusIfStale()
        refreshLecturesIfStale()
        fetch("/api/portfolio", as: Portfolio.self) { portfolio in
            guard let portfolio else {
                done(.unreachable("IRIS が応答しません"))
                return
            }
            guard portfolio.ok else {
                done(.unreadable(portfolio.reason ?? "台帳を読めません"))
                return
            }
            self.fetch("/api/agent/runs", as: AgentRuns.self) { runs in
                self.fetch("/api/approvals/pending", as: Approvals.self) { approvals in
                    self.fetch("/api/proactive", as: Proactive.self) { proactive in
                        self.fetch("/api/calendar", as: Calendar.self) { calendar in
                            self.fetch("/api/budget", as: Budget.self) { budget in
                                self.fetch("/api/sessions?hours=8", as: Sessions.self) { sessions in
                                  self.fetch("/api/weather", as: Weather.self) { weather in
                              self.fetch("/api/review/capability", as: ReviewCapability.self) { review in
                               self.fetch("/api/dev/runs/stalled", as: StalledRuns.self) { stalled in
                                self.fetch("/api/exam/next", as: NextExam.self) { exam in
                                 self.fetch("/api/backup/repo", as: RepoBackup.self) { backup in
                                  self.fetch("/api/usage/cli", as: CliUsage.self) { usage in
                                   self.fetch("/api/travel/next", as: Destination.self) { destination in
                                    /**
                                     * Asked here, answered maybe later.
                                     *
                                     * `minutes(to:)` returns a figure if one
                                     * is fresh and starts a request if not,
                                     * so the first poll after an appointment
                                     * comes into range has no travel time and
                                     * the next one does. Forty-five seconds,
                                     * against a number that only matters
                                     * within three hours of leaving.
                                     */
                                    let places = destination?.knownPlaces ?? []
                                    let road: Road? = destination?.to.map { address in
                                        Road(
                                            minutes: Travel.shared.minutes(to: address),
                                            reason: Travel.shared.reason
                                        )
                                    }
                                    done(.ready(Everything(
                                        portfolio: portfolio,
                                        runs: runs?.runs ?? [],
                                        approvals: approvals?.pendingApprovals.count ?? 0,
                                        pending: approvals?.pendingApprovals ?? [],
                                        suggestions: proactive?.pending.count ?? 0,
                                        // 数えるだけでなく、**中身を持ち歩く。**
                                        // IRIS の側から声をかけるのに要る。
                                        suggestionList: proactive?.pending ?? [],
                                        events: calendar?.events ?? [],
                                        budget: budget,
                                        sessions: sessions?.sessions ?? [],
                                        weather: weather,
                                        places: places,
                                        exam: exam,
                                        road: road,
                                        usage: usage,
                                        backup: backup,
                                        fdp: self.fdp,
                                        dev: self.dev,
                                        stalledRuns: stalled?.runs.count ?? 0,
                                        breakdown: self.breakdown,
                                        review: review,
                                        focus: self.focus,
                                        lectures: self.lectures
                                    )))
                                   }
                                  }
                                 }
                                }
                               }
                              }
                             }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Started, not waited for. The snapshot goes out with whatever the last
     * successful read produced; a slow figure must not hold up a fast one.
     */
    private func refreshDevIfStale() {
        if let at = devAt, Date().timeIntervalSince(at) < 5 * 60 { return }
        devAt = Date()
        guard let url = URL(string: "http://127.0.0.1:3002/api/dev/tasks") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        URLSession(configuration: .ephemeral).dataTask(with: request) { [weak self] data, _, _ in
            /**
             * 応答は `{"tasks":[...]}`。**裸の配列ではない。**
             *
             * 配列として読もうとして毎回失敗し、`dev=-1` のまま IRIS の行が
             * 一つも出ていなかった。**失敗しても静かなので、画面には
             * 「IRIS は何もしていない」としか見えない** — 記録に件数を
             * 残していなければ、また台帳の側を疑っていた。
             */
            guard let data, let decoded = try? JSONDecoder().decode(DevTasks.self, from: data)
            else { return }
            DispatchQueue.main.async { self?.devCache = decoded.tasks }
        }.resume()
    }

    private func refreshFocusIfStale() {
        if let at = focusAt, Date().timeIntervalSince(at) < 5 * 60 { return }
        focusAt = Date()
        guard let url = URL(string: "http://127.0.0.1:3002/api/focus") else { return }
        var request = URLRequest(url: url)
        // 表を読みに行くので長い。それでも待つのはこの取得だけ。
        request.timeoutInterval = 60
        URLSession(configuration: .ephemeral).dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let decoded = try? JSONDecoder().decode(Focus.self, from: data) else { return }
            DispatchQueue.main.async { self?.focusCache = decoded }
        }.resume()
    }

    private func refreshLecturesIfStale() {
        if let at = lecturesAt, Date().timeIntervalSince(at) < 30 * 60 { return }
        lecturesAt = Date()
        guard let url = URL(string: "http://127.0.0.1:3002/api/lectures/divergence?days=14") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        URLSession(configuration: .ephemeral).dataTask(with: request) { [weak self] data, _, _ in
            guard let data else { trace("lectures: 応答なし"); return }
            guard let decoded = try? JSONDecoder().decode(LectureDivergence.self, from: data) else {
                // **読めなかったことを黙らない。**dev の一覧で同じ失敗をして、
                // 画面には「IRIS は何もしていない」としか見えなかった。
                trace("lectures: 読めず \(String(data: data.prefix(200), encoding: .utf8) ?? "")")
                return
            }
            trace("lectures: compared=\(decoded.compared) moved=\(decoded.moved.count) missing=\(decoded.missing.count)")
            DispatchQueue.main.async { self?.lecturesCache = decoded }
        }.resume()
    }

    private func refreshFdpIfStale() {
        if let at = fdpAt, Date().timeIntervalSince(at) < 5 * 60 { return }
        fdpAt = Date()
        guard let url = URL(string: "http://127.0.0.1:3002/api/fdp/tasks") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        URLSession(configuration: .ephemeral).dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let decoded = try? JSONDecoder().decode(FdpTasks.self, from: data) else { return }
            DispatchQueue.main.async { self?.fdpCache = decoded }
        }.resume()
    }

    private func refreshBreakdownIfStale() {
        if let at = breakdownAt, Date().timeIntervalSince(at) < 15 * 60 { return }
        breakdownAt = Date()
        guard let url = URL(string: "http://127.0.0.1:3002/api/allowance/breakdown?days=7") else { return }
        var request = URLRequest(url: url)
        // Its own timeout: the shared 4-second one would never see this finish.
        request.timeoutInterval = 90
        URLSession(configuration: .ephemeral).dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let decoded = try? JSONDecoder().decode(AllowanceBreakdown.self, from: data) else { return }
            DispatchQueue.main.async { self?.breakdownCache = decoded }
        }.resume()
    }

    private func fetch<T: Decodable & Sendable>(_ path: String, as type: T.Type, done: @escaping (T?) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:3002" + path) else {
            done(nil)
            return
        }
        session.dataTask(with: url) { data, _, _ in
            // `T.self` rather than the captured parameter: a metatype crossing
            // into the completion handler is not Sendable, and capturing it
            // warns for a value that is already known at the call site.
            guard let data, let value = try? JSONDecoder().decode(T.self, from: data) else {
                DispatchQueue.main.async { done(nil) }
                return
            }
            DispatchQueue.main.async { done(value) }
        }.resume()
    }
}

/**
 * The next event that has not started yet.
 *
 * Compared as strings, because the API already returns local wall time in a
 * sortable form (`2026-08-21T14:30`) and building a Date from it only to
 * format it back would introduce a timezone to get wrong. All-day entries are
 * skipped: "next" means a time to be somewhere, and an all-day banner is not
 * one.
 */
/**
 * 予定の開始時刻。**切り出さず、解釈する。**
 *
 * `/api/calendar` は出所によって三つの形を返す：`2026-09-01T17:00`、
 * `2026-09-01T17:00:00+09:00`、そして終日の `2026-09-02`。末尾5文字を時刻と
 * みなすと、二つ目は時間帯の `+09:00` を読んで **17:00 の出勤が 09:00 に
 * なる**。帯で一度直したのに、レールの予定でもう一度やった — だから解釈は
 * ここ一箇所だけに置く。二つあれば必ずずれる。
 */
func eventDate(_ start: String) -> Date? {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime]
    if let date = iso.date(from: start) { return date }
    let wall = DateFormatter()
    wall.dateFormat = "yyyy-MM-dd'T'HH:mm"
    if let date = wall.date(from: start) { return date }
    // 終日は日付だけ。時刻が無いことは、予定が無いことではない。
    let day = DateFormatter()
    day.dateFormat = "yyyy-MM-dd"
    return day.date(from: start)
}

func nextUpcoming(_ events: [CalendarEvent]) -> CalendarEvent? {
    /**
     * Compared as dates, not as strings.
     *
     * String order works only while every value has the same shape, and this
     * API returns two: `2026-08-23T15:30` from one source and
     * `2026-08-23T15:30:00+09:00` from another. Sorting those together puts
     * them in an order that has nothing to do with time.
     */
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime]
    let plain = DateFormatter()
    plain.dateFormat = "yyyy-MM-dd'T'HH:mm"
    let now = Date()

    return events
        .compactMap { event -> (CalendarEvent, Date)? in
            guard !event.allDay else { return nil }
            guard let at = iso.date(from: event.start) ?? plain.date(from: event.start) else {
                return nil
            }
            return at >= now ? (event, at) : nil
        }
        .min { $0.1 < $1.1 }?
        .0
}


// MARK: - The strip

/**
 * The application's own palette, copied from `src/index.css`.
 *
 * Copied rather than approximated. A band that sits above the app and is
 * nearly its colour reads as a mistake; matching it exactly is the difference
 * between one product and two.
 */
enum Palette {
    /**
     * `--hud-panel`, not `--hud-bg`.
     *
     * The band is a surface laid over other windows, which is what a panel is
     * in this design language — and the panel token is the blue one. The page
     * ground (`#04070C`) is nearly neutral and read as plain black once it was
     * opaque, which is not what the rest of the interface looks like.
     */
    /**
     * 地の色はレールに合わせる。
     *
     * 盤とレールは並んで出るので、**地が違うと別の道具に見える**
     * — 2026-09-01 の決定「IRIS の見た目は、右レールの意匠に寄せる」。
     */
    static let ground = rgb(0x14, 0x18, 0x1F)
    /**
     * What the application's panel actually looks like on screen.
     *
     * `--hud-panel` is `rgba(17, 26, 37, 0.82)`, and using those three numbers
     * directly gives a colour nine points too dark in every channel — the token
     * is a paint, and what the eye compares against is the paint composited
     * over `--hud-bg`. Computed rather than sampled: 0.82 x (17,26,37) plus
     * 0.18 x (4,7,12) is (15,23,32).
     */
    static let groundDeep = rgb(0x0C, 0x0E, 0x12)
    /// `--hud-text`
    static let headline = rgb(0xDC, 0xE7, 0xF2)
    /// `--hud-muted`
    static let aside = rgb(0x89, 0x95, 0xA3)
    /// `--hud-warn`. Something is wrong.
    /**
     * 黄色は使わない。**そして一度戻った。**
     *
     * `#FBBF24` は彩度 96% の黄。暗い地の上で彩度の高い色は光学的に振動する
     * ので、明色版より彩度を落とすのが定石 — と決めて直したのに、別の作業で
     * このファイルを巻き戻したときに**配色の変更ごと戻っていた。**コミットの
     * 本文には「落とした」と書いてある。**書いたことと入っているものが違って
     * いた**わけで、この計画がいちばん嫌う形そのもの。
     *
     * 値は `docs/dark-ui-colour.md` が持つ。ここは参照する側。
     */
    static let attention = rgb(0xC7, 0x91, 0x5E)
    /// `--hud-pending`. Working as designed, and waiting on a person.
    /// 承認待ちは注意と同じ色。**同じ「人を待っている」に二つの色を持たない。**
    static let pending = rgb(0xC7, 0x91, 0x5E)
    /// `--hud-accent`
    /**
     * アクセントは一色。シアンをやめた。
     *
     * 明るいシアンは AI 製品の色に見えるうえ、**黄・緑・赤と同時に光ると
     * 状態色が画面の主役になる。**目安は 地と面 85%、文字 10%、
     * アクセント 4%、状態色 1%。いまは状態色が多すぎた。
     *
     * IRIS の核（レールの印）は青のまま。あれはアクセントではなく**この
     * 道具の顔**で、役割が違う。
     */
    /**
     * アクセントは青。橙ではない。
     *
     * 一度、橙をアクセントにした。**そうすると橙が二つの意味を持つ**
     * — 構造（リンク・選択）と、注意。**同じ色が二つの意味を持つと、
     * どちらでもなくなる。**そして画面には既に青がいる：レールの核で、
     * これは動かせない（この道具の顔なので）。
     *
     * だから青を構造の色、橙を**視線の行き先**にする。青は主役で数が多く、
     * 橙は少ないほど効く — 目安は 地と文字 85%、青 10%、橙 5%。
     */
    static let accent = rgb(0x5B, 0x9C, 0xF5)
    static let mark = rgb(0x89, 0x95, 0xA3)

    /**
     * The band's own palette, which diverges from the application's on purpose.
     *
     * Everything above mirrors a token in `src/index.css`, because the panels
     * in the application and the dashboard should be the same surface. The
     * band is not a panel — it is a strip laid over whatever the person is
     * actually working in, at the top of the screen, for hours.
     *
     * So it goes colder and darker than the panel: a ground close to black
     * with the blue still in it, text at a pale cyan rather than the
     * near-white the application uses, and secondary text further down the
     * same hue instead of off toward grey. Nothing here is more saturated
     * than the application — the opposite. A neon band would be exhausting to
     * sit under, and the thing being imitated is not neon; it is instrument
     * glass, which is mostly dark.
     *
     * The warning colours are untouched. Amber and violet mean the same
     * things everywhere in IRIS, and a surface that recoloured them would be
     * teaching a second vocabulary for one language.
     */
    enum Band {
        static let ground = rgb(0x08, 0x10, 0x1A)
        /// Primary text.
        static let headline = rgb(0xC8, 0xE6, 0xF6)
        /// Emphasis, where the application would reach for a second hue.
        static let emphasis = rgb(0xA7, 0xDD, 0xF4)
        /// Secondary text.
        static let aside = rgb(0x78, 0x97, 0xAA)
        static let rule = NSColor(calibratedRed: 120/255, green: 190/255, blue: 220/255, alpha: 0.25)
        static let edge = NSColor(calibratedRed: 110/255, green: 210/255, blue: 245/255, alpha: 0.55)
        /**
         * What replaces violet here.
         *
         * `Palette.pending` is a lavender, and it means "waiting on a person"
         * everywhere else in IRIS. On the band it was the one warm-cool note
         * in a field of blue and it pulled the eye for a reason the reader
         * could not name. This surface says the same thing with weight and
         * brightness instead: the pending tone is simply the brightest cyan on
         * the strip. Amber stays, because a warning that is a shade of the
         * ambient colour is not a warning.
         */
        static let pending = rgb(0xA7, 0xDD, 0xF4)
    }
    /// `--hud-line`
    /// 罫。地から少しだけ持ち上げた無彩色で、シアンではない。**文字には使わない。**
    static let line = rgb(0x2A, 0x2F, 0x38)

    /**
     * 盤だけの色。
     *
     * `Palette.groundDeep` はレールなど別の面でも使っているので、ここを
     * 変えると関係ない画面まで動く。**参考画像から測った値をそのまま**、
     * 盤専用に持つ。混ぜない。
     */
    enum Board {
        /// 窓の外側。**純黒。**
        static let outside = NSColor.black
        /// 盤の面。画像でいちばん多く使われている値。**一色で塗る。**
        static let ground = rgb(0x06, 0x07, 0x0A)
        /// 外周の細い線。
        static let edge = rgb(0x48, 0x4B, 0x4D)
        /// 見出しの下の、外周より控えめな線。
        static let divider = rgb(0x38, 0x36, 0x39)
        static let text = rgb(0xFF, 0xFF, 0xFF)
        static let subtle = rgb(0xA6, 0xAA, 0xB1)
        /// 確認が要るものだけ。**行や背景は塗らない。**
        static let amber = rgb(0xFC, 0xBC, 0x70)
    }
    /// `--hud-ok`
    static let done = rgb(0x6F, 0xAF, 0x91)
    /// `--hud-danger`
    static let danger = rgb(0xC9, 0x6D, 0x69)

    private static func rgb(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
        NSColor(
            calibratedRed: CGFloat(r) / 255, green: CGFloat(g) / 255,
            blue: CGFloat(b) / 255, alpha: 1
        )
    }
}

/**
 * The core, at the size a strip allows.
 *
 * Not the field from the app. That is four thousand particles in an
 * accumulation buffer, and at 34 points across, none of it would resolve — it
 * would read as a smudge and cost battery to compute. What survives at this
 * size is the shape: a ring of moving light, turning at a rate that says
 * whether anything is happening.
 *
 * The hue is 198, the same one every state of the real core uses. Only the
 * speed and the brightness change, which is also how the real one distinguishes
 * its states.
 */
final class CoreView: NSView {
    /**
     * The field, with trails, the way the application draws it.
     *
     * The first version put 108 dots on three rings and it read as thin,
     * because the thing that makes the real core look dense is not the number
     * of particles — it is that each one leaves a trail. `src/Core.tsx` got
     * that from an accumulation buffer: every frame it draws new dots over the
     * old image and then fades the whole image slightly.
     *
     * A screenshot of the real core was the other option. It loses on two
     * counts: it cannot answer to state, and at 36 points the texture that
     * makes it worth copying does not survive the downscale. What survives is
     * the technique, and the technique ports.
     *
     * The fade is done by redrawing the buffer through itself at a fraction of
     * opacity, not by laying a dark rectangle over it. That is the note in
     * Core.tsx worth carrying (the file is gone; it reads at `ab9eedf`): painting over accumulates colour instead of
     * removing it, and the field creeps to white and then to red. Scaling the
     * premultiplied colour decays every pixel geometrically and settles.
     */

    /**
     * 熱から色へ。**`src/Core.tsx` と同じ数値**（web 側は絵に置き換わり、
     * この実装は履歴にだけある —— `git show ab9eedf:src/Core.tsx`）。
     *
     * ここは長いあいだ単色（rgb 0.20/0.72/0.99）だった。web 側のコアに淡い
     * 桃を入れたとき、こちらを置き去りにしたので**同じ印が二種類**になった。
     *
     * HSL で書いてあるのは、向こうがそう書いてあるから。数値を見比べられる
     * ことの方が、こちらで HSB に直しておく便利さより価値がある。色を変える
     * ときは両方。
     *
     * **揃えるのは骨格だけ**（2026-09-05 の決定）。半径・空洞の大きさ・色 —
     * 見て「同じ印だ」と分かるところ。**動きの作りまでは合わせない。**
     *
     * 本体は色を粒に運ばせて混ぜているが、こちらの粒には寿命が無く、生まれたら
     * 回り続ける。印を持たせると**その粒の色が一生変わらない**ので、移せば
     * 混ざるどころか固まる。こちらは小さく、そこまでの解像度も要らない。
     *
     * **差があること自体は不具合ではない。**直しにかかる前にここを読むこと。
     */
    private static func ink(heat: CGFloat) -> NSColor {
        let u = min(1, max(0, 1 - heat))
        let rose: CGFloat = 0.28
        let h: CGFloat, sat: CGFloat, lit: CGFloat
        if u <= rose {
            let t = u / rose
            h = 348 - 16 * t
            sat = (84 - 6 * t) / 100
            lit = (78 - 12 * t) / 100
        } else {
            let t = (u - rose) / (1 - rose)
            h = 202 + (260 - 202) * (1 - t)
            sat = 1
            lit = 0.5
        }
        // HSL → HSB。NSColor は HSB しか受けない。
        let v = lit + sat * min(lit, 1 - lit)
        let sb = v <= 0 ? 0 : 2 * (1 - lit / v)
        return NSColor(calibratedHue: h / 360, saturation: sb, brightness: v, alpha: 1)
    }

    private var particles: [(angle: CGFloat, radius: CGFloat, speed: CGFloat)] = []
    private var buffer: CGContext?
    private var scratch: CGContext?
    private var timer: Timer?
    /// 色の帯を回すための時計。粒の位置とは別に持つ（止めても色は止まる）。
    private var drift: CGFloat = 0
    private var pixels: Int = 0

    /// Turns faster while work is in flight, and dims when nothing is reachable.
    var pace: CGFloat = 1.0
    var brightness: CGFloat = 1.0

    override var isFlipped: Bool { false }

    /**
     * Whether the field moves.
     *
     * Offered because motion at the top of the screen is not free: it costs a
     * little battery and a little attention, and someone studying may want
     * neither. Held still the trails stay where they were, so the shape reads
     * the same; only the advance stops.
     */
    var animates: Bool = true

    func start() {
        guard timer == nil else { return }
        seed()
        // 20fps. The ring is 36 points across; a display link would spend
        // battery rendering motion at a rate nobody can see at this size.
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            guard let self, self.animates else { return }
            // Paused while the band is not on screen. An animation nobody is
            // looking at is pure cost.
            if self.window?.occlusionState.contains(.visible) == false { return }
            self.advance()
            self.needsDisplay = true
        }
    }

    /// 葉の向きをゆっくり回す。止まっていると模様が固定されて見える。
    private var roll: CGFloat = 0

    fileprivate func seed() {
        /**
         * 六百。二百四十から増やした。
         *
         * 本物は 4200 粒だが、あれは画面いっぱいの場。三十六ポイントでは
         * 数を増やしても点が重なるだけ — ただし 240 は疎すぎて、**尾が
         * 繋がらず「点が回っている」に見えていた。**六百で場になる。
         */
        particles = (0..<600).map { _ in
            (
                angle: CGFloat.random(in: 0..<(.pi * 2)),
                // Spread across a band rather than sitting on one circle: a
                // single radius is a ring, a band is a field.
                /*
                 * 内側は **本体のコアと同じ比**。
                 *
                 * web 側のキャンバスを測ると、輪は半径の 0.500〜0.800 に
                 * 立っている（内外の比 0.625）。こちらは 1.30 が外なので、
                 * 内は 0.81。
                 *
                 * 一度 0.30 まで詰めて「小さすぎる」、その前の 0.477 で
                 * 「大きすぎる」と言われている。**目分量で行き来させない**
                 * ために、本体を測ってその比に合わせる。二つは同じ印なので、
                 * 片方に合わせる先があるなら、それが答えになる。
                 */
                radius: CGFloat.random(in: 0.81...1.30),
                // Each particle keeps its own rate, so the field shears instead
                // of turning rigidly. The real one gets this from radius.
                speed: CGFloat.random(in: 0.55...1.45)
            )
        }
    }

    /**
     * 核を静止画として一枚。
     *
     * 盤の行に置くため。**別に描き起こすと、同じものが二つになって必ず
     * ずれる** — 今日ずっと直してきたのがその形。同じ場を同じ式で回して、
     * 落ち着いたところで写し取る。
     *
     * 一度作ったら覚えておく。行ごとに回すと電池を使うし、静止画で足りる。
     */
    static func still(side: CGFloat) -> NSImage? {
        if let held = stillCache { return held }
        let view = CoreView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.seed()
        view.ensureBuffers()
        // 尾が溜まるまで回す。一枚目は点が並んでいるだけになる。
        for _ in 0..<90 { view.advance() }
        let image = NSImage(size: NSSize(width: side, height: side))
        image.lockFocus()
        view.draw(NSRect(x: 0, y: 0, width: side, height: side))
        image.unlockFocus()
        stillCache = image
        return image
    }

    private static var stillCache: NSImage?

    /**
     * コアの絵。束から一度だけ読む。
     *
     * `menubar/icons/Core.png` は `public/iris-matteo-core.png`（1254px）を
     * 256px に落としたもの。使う先はいちばん大きいところで 44pt なので、
     * 三倍の画面でも足りる。**元のまま束に入れると 2.4MB がアプリに乗る。**
     *
     * 読めなければ `nil`。**そのときは前の粒に落ちる**（`draw` を参照） ——
     * 印が消えるより、違う描き方でも印が在る方がいい。
     */
    fileprivate static let artwork: CGImage? = {
        guard let url = Bundle.main.url(forResource: "Core", withExtension: "png"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        return image
    }()

    fileprivate func ensureBuffers() {
        // 三倍で持つ。三十六ポイントの中の粒は、二倍だと一画素に丸まる。
        let side = Int(max(bounds.width, 1) * 3)
        guard side > 0, side != pixels || buffer == nil else { return }
        pixels = side
        let space = CGColorSpaceCreateDeviceRGB()
        let make = {
            CGContext(
                data: nil, width: side, height: side, bitsPerComponent: 8,
                bytesPerRow: 0, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        }
        buffer = make()
        scratch = make()
    }

    fileprivate func advance() {
        ensureBuffers()
        guard let buffer, let scratch else { return }
        let side = CGFloat(pixels)
        let centre = CGPoint(x: side / 2, y: side / 2)
        let unit = side * 0.30

        buffer.setBlendMode(.plusLighter)
        roll += 0.0011 * pace
        // 色の帯を進める。粒の回転と同じ拍で、web と同じ速さ（一周およそ37秒）。
        drift += pace / 60
        for i in particles.indices {
            var p = particles[i]
            /**
             * 回る速さは、中心に近いほど速い。
             *
             * 一定の角速度で回していたので、**場ではなく円盤が回って見えて
             * いた。**本物は `swirl / (r + SOFTEN)` — 角速度が内側で上がり、
             * 外側では長い掃き跡になる。「内側は急旋回、外側は長い弧」が
             * あの見た目の正体で、**粒の数より先にこれが効く。**
             */
            /**
             * 向きは逆。**同じ符号では逆に回る。**
             *
             * 本物は canvas に描いていて y が下向き、こちらは `CGContext` で
             * y が上向き。角度を増やすと、あちらは時計回り、こちらは反時計
             * 回りになる。**式を写しただけでは逆になる**という、今日レールの
             * 輪でも踏んだのと同じ穴。
             */
            let angular = min(0.16, 0.052 / (p.radius * 0.72 + 0.34))
            p.angle -= angular * p.speed * pace
            // A slow breath in and out, so the band is never a fixed annulus.
            /**
             * 出入りは三つ葉と五つ葉の混ぜ合わせ。
             *
             * `sin(angle * 1.7 + i)` は粒ごとにばらばらの揺れで、**場として
             * の形を持たない。**本物は `sin(3a)` と `sin(5a)` を混ぜて、
             * `r(1-r)` を掛ける — 中心でも縁でも0になるので、潰れも逃げも
             * しない。**葉の形が見えるのは、これがあるから。**
             */
            let lobe3 = sin(3 * p.angle + roll * 6.283)
            let lobe5 = sin(5 * p.angle + roll * 4.1)
            let lobes = lobe3 * 0.7 + lobe5 * 0.3
            let shape = p.radius * (1 - min(1, p.radius))
            p.radius += lobes * shape * 0.010
            // 中心は空けたまま、縁からは出さない。本物と同じ二つの押し戻し。
            if p.radius < 0.81 { p.radius += (0.81 - p.radius) * 0.22 }
            if p.radius > 1.24 { p.radius -= (p.radius - 1.24) * 0.28 }
            p.radius = min(1.34, max(0.74, p.radius))
            particles[i] = p

            let at = CGPoint(
                x: centre.x + cos(p.angle) * unit * p.radius,
                y: centre.y + sin(p.angle) * unit * p.radius
            )
            // Lit in runs rather than evenly. An even field reads as a spinner;
            // the real core is mostly dark with bright passages through it.
            /**
             * 明るいのは一部だけ。
             *
             * 全部の粒を連続的に明滅させると、**均された霞**になる。本物は
             * `litFraction` — 静かなときは 14% だけが灯り、残りは暗い青の
             * まま流れる。まばらな輝点があるから、尾が尾に見える。
             */
            let phase = sin(p.angle * 3 + p.radius * 6 + CGFloat(i) * 0.37)
            let lit = phase > 0.72 ? pow((phase - 0.72) / 0.28, 1.4) : 0
            let alpha = (0.035 + lit * 0.42) * brightness
            /*
             * 熱は**場所に付く**。粒ごとではない。web 側と同じ式。
             *
             * 粒の明滅だけで色を決めると、青地に桃の点が散るだけで塊にならない。
             * 角度と半径の滑らかな波にすると、隣り合う粒が同じ熱を持つので
             * 桃が帯として現れる。
             *
             * `r` は 0.62〜1.34 の帯なので、web の 0〜1 に合わせて畳んでいる。
             */
            let r = min(1, max(0, (p.radius - 0.56) / 0.78))
            let wave = 0.5 + 0.5 * sin(p.angle * 2 - drift * 0.34 + r * 3.4)
                * (0.6 + 0.4 * sin(p.angle * 3 + drift * 0.19))
            let heat = min(1, max(0, wave * 0.70 + lit * 0.26 + (1 - r) * 0.16 - 0.04))
            buffer.setFillColor(Self.ink(heat: heat).withAlphaComponent(alpha).cgColor)
            buffer.fillEllipse(in: CGRect(x: at.x - 1.0, y: at.y - 1.0, width: 2.0, height: 2.0))
        }

        // The fade, through the buffer itself. See the note above for why this
        // is not a dark rectangle laid over the top.
        let keep: CGFloat = 0.88
        if let image = buffer.makeImage() {
            let whole = CGRect(x: 0, y: 0, width: side, height: side)
            scratch.setBlendMode(.copy)
            scratch.setAlpha(1)
            scratch.draw(image, in: whole)
            if let faded = scratch.makeImage() {
                buffer.setBlendMode(.copy)
                buffer.setAlpha(keep)
                buffer.draw(faded, in: whole)
                buffer.setAlpha(1)
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let centre = CGPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) * 0.34

        /**
         * The glow behind the field, before the field.
         *
         * `.hud-visor::before` in the application does the same thing: light in
         * a space rather than lines drawn on a void. Without it the particles
         * fall to black at their edges and read as dots on a rectangle.
         */
        if let glow = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [
                NSColor(calibratedRed: 0.18, green: 0.62, blue: 0.95, alpha: 0.30 * brightness).cgColor,
                NSColor(calibratedRed: 0.10, green: 0.40, blue: 0.75, alpha: 0.0).cgColor,
            ] as CFArray,
            locations: [0, 1]
        ) {
            context.drawRadialGradient(
                glow, startCenter: centre, startRadius: 0,
                endCenter: centre, endRadius: radius * 2.1, options: []
            )
        }

        /**
         * 場そのものを描く。**粒で似せるのをやめた。**
         *
         * ここは長いあいだ粒を回して web のコアに寄せていた。寄せる相手が
         * 変わった —— 2026-09-07、本体のコアは `src/coreFlow.ts` の断片
         * シェーダで、**一枚の絵（`public/iris-matteo-core.png`）を流れで
         * 歪ませる**作りになった。輪も空洞も無い。粒をどう回しても、これには
         * ならない。
         *
         * 「絵を貼るのは二つの点で負ける」と、ここには書いてあった ——
         * **状態に応えられない**のと、**36ポイントに落とすと写す値打ちの
         * ある肌理が残らない**の二つ。前者は下の明るさと走査で応える。
         * 後者は測り直した: 元絵を 72px（36pt @2x）と 88px（44pt @2x）に
         * 落として見ると、渦の筋は残る。**あの判断は粒でできたコアについての
         * もので、この絵には当てはまらない。**
         *
         * 流れの再現はしない（2026-09-05 の決定「揃えるのは骨格だけ、動きの
         * 作りまでは合わせない」）。**回しもしない** —— 一枚絵を回すと、
         * 全画面で何度も却下された「鯉が回っている」がそのまま小さくなって
         * 出る。ここでの生きている感じは、背後の光と走査が持つ。
         */
        if let field = Self.artwork {
            /*
             * 素の重ね方で置く。**加算にしない。**
             *
             * 最初は粒と同じ `.plusLighter` にした。粒の緩衝は前掛けの
             * 済んだ画（黒＝不透明度0）だが、**この絵の黒は不透明な黒。**
             * 透明な層に加算すると黒がそのまま乗って不透明度1になり、
             * 印の周りに**黒い四角**が出た（実機で確認）。
             *
             * 絵の側に不透明度を持たせてある（`icons/Core.png` は濃さから
             * 起こした α 付き。本体のシェーダの
             * `alpha = 1 - exp(-density * 16)` と同じ考え方）ので、素の重ね方で
             * 縁が地に溶ける。背後の光は下で別に描いている。
             */
            context.saveGState()
            context.setAlpha(min(1, brightness))
            context.draw(field, in: bounds)
            context.restoreGState()
        } else if let buffer, let image = buffer.makeImage() {
            // 絵が束に入っていなかったとき用。**印が消えるよりは、前の粒。**
            context.setBlendMode(.plusLighter)
            context.draw(image, in: bounds)
        }

        /*
         * 囲いの輪は無い（利用者、2026-09-07「別に丸で囲わなくていいよ」）。
         *
         * ここには細い円を描いていた。理由も書いてあった —— **粒だけでは
         * 群れにしか見えず、輪郭があって初めて計器として読める。**それは
         * 粒の話で、いまは絵が円板いっぱいに詰まっている。**輪郭は絵の縁を
         * なぞるだけの二本目の線**になり、しかも絵の縁は地へ溶けていく形
         * なので、溶けていく先に硬い線を引くことになる。
         *
         * レールの他の印（Claude / Codex）は輪を持つが、あれは**使用量の
         * 目盛り**で、意味のある輪。ここに同じ形を置くと、目盛りに見える。
         */
        /**
         * The scan, and only when there is something to scan for.
         *
         * A mark that runs whatever is happening is decoration. This appears
         * while work is in flight and is absent otherwise, so its presence is
         * itself the reading.
         */
        /*
         * 走査だけは残す。**囲いを外しても、これは目盛りではない。**
         *
         * 出るのは働いているあいだだけなので、**在ること自体が読み**になる。
         * 囲いの輪と同じ半径に描いていたが、輪が無くなったので少し内側へ
         * 寄せる —— 何も無いところに浮いた弧が出ると、消えかけの輪に見える。
         */
        if pace > 1.8, let first = particles.first {
            let sweep = first.angle
            context.setStrokeColor(
                NSColor(calibratedRed: 0.42, green: 0.86, blue: 1.0, alpha: 0.55 * brightness).cgColor
            )
            context.setLineWidth(1.4)
            context.setLineCap(.round)
            context.addArc(
                center: centre, radius: radius * 1.34,
                startAngle: sweep, endAngle: sweep + 0.7, clockwise: false
            )
            context.strokePath()
        }
    }
}

struct Lines {
    enum Tone { case normal, warning, pending }

    let headline: String
    let aside: String
    /// Drawn in a signal colour when the person has to do something.
    let wantsAttention: Bool
    var tone: Tone = .warning
}

func lines(for snapshot: Snapshot) -> Lines {
    switch snapshot {
    case .unreachable:
        return Lines(
            headline: "IRIS に接続できません。",
            /**
             * Says what is on screen, not what is wrong. A strip that keeps
             * showing the last good numbers with no note beside them is worse
             * than one showing nothing: the figures look current.
             */
            aside: "表示は更新が止まった時点のものです。",
            wantsAttention: false
        )

    case let .unreadable(why):
        return Lines(headline: "台帳を読めません。", aside: why, wantsAttention: true)

    case let .ready(all):
        let running = all.runs.filter { $0.state == "running" }
        let projects = all.portfolio.projects ?? []
        // 完了・全体・停止の合計はもう誰も読んでいない。帯の一文で使って
        // いたもので、その一文は盤から外した。

        /**
         * The next thing, said the way a person would say it.
         *
         * It was "次は 14:30「薬理学の復習」。それまで少しずつ。" — a time with no
         * day attached, and a closing phrase that adds nothing. The day matters:
         * 14:30 reads as today and is often not, and a line that has to be
         * worked out is worse than a longer one that does not.
         *
         * The encouragement is gone. It was there to make the band sound less
         * mechanical and it made it sound more so, because it said the same
         * thing regardless of what was happening.
         */
        /**
         * Parsed, not sliced.
         *
         * The first version took the last five characters as the time and the
         * first ten as the date, which works for `2026-08-23T15:30` and is
         * wrong for `2026-08-23T15:30:00+09:00` — where the last five
         * characters are the offset. The band announced "明日の予定は 09:00" for
         * an appointment at 15:30 the day after, reading a timezone as a clock.
         *
         * `/api/calendar` returns both shapes depending on the source, so both
         * are parsed and neither is assumed.
         */
        /**
         * Today and tomorrow, both, and in that order.
         *
         * It said whichever was nearest and stopped, so a day with an
         * appointment at four and another tomorrow morning showed only the
         * four — and once four had passed, only tomorrow, with nothing to say
         * the afternoon was clear rather than unread. Two clauses cost the
         * width they take and remove that ambiguity entirely: a day with
         * nothing in it now says so.
         */
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm"
        let calendar = Foundation.Calendar.current

        let dated = all.events.compactMap { event -> (Date, CalendarEvent)? in
            // 終日は時刻を持たないので、ここでは落ちる。この行が言うのは
            // 「次に居るべき場所と時刻」で、終日の帯はその答えではない。
            event.allDay ? nil : eventDate(event.start).map { ($0, event) }
        }.sorted { $0.0 < $1.0 }

        let today = dated.first { calendar.isDateInToday($0.0) && $0.0 > Date() }
        let tomorrow = dated.first { calendar.isDateInTomorrow($0.0) }

        /**
         * The road, when it has been measured.
         *
         * Said as a sentence rather than as a label and a number. "移動 4分"
         * is a readout on a dashboard; this line is being read, not scanned.
         */
        let road: String = {
            if let minutes = all.road?.minutes { return "移動には \(minutes)分 かかります。" }
            if let why = all.road?.reason, why.contains("許可") || why.contains("見つかりません") {
                return " \(why)"
            }
            return ""
        }()

        let next: String? = {
            var parts: [String] = []
            /**
             * Quoted only when the name is not one.
             *
             * A calendar title is arbitrary text, and quoting is what keeps it
             * from running into the sentence around it — 「歯医者 15時まで」 needs
             * the marks. But a title this machine can turn into an address is
             * a place, and a place is a word: 明日は 15:30 からガウス。 reads as
             * language rather than as a field with a value in it.
             */
            func name(_ title: String) -> String {
                let short = clip(subject(title), 14)
                let known = all.places.contains { !$0.isEmpty && title.localizedCaseInsensitiveContains($0) }
                return known ? short : "「\(short)」"
            }

            if let (at, event) = today {
                parts.append("今日は \(clock.string(from: at)) から\(name(event.title))です。")
            } else {
                parts.append("今日の今後の予定はありません。")
            }
            if let (at, event) = tomorrow {
                parts.append("明日は \(clock.string(from: at)) から\(name(event.title))です。")
            }
            let line = parts.joined(separator: " ") + road
            return line.isEmpty ? nil : line
        }()

        /**
         * Ordered by who is waiting for whom.
         *
         * A decision the person owes comes first, because nothing else moves
         * until they make it. Work in flight is next — it is the answer to
         * "is it running". Suggestions wait, and the idle line is last.
         */
        /**
         * A failing backup, before anything else that is merely interesting.
         *
         * Above the running count and below an approval, which is the right
         * place: nothing is blocked on it right now, and it is the only line
         * here that gets worse the longer it is ignored. Only shown when it
         * has actually failed — an idle repository with nothing to send is
         * not news.
         */
        if let why = all.backup?.lastError {
            let held = (all.backup?.unpushed ?? 0) > 0
                ? "手元にしかないコミットが \(all.backup!.unpushed!)件あります。"
                : "手元とリモートの差は不明です。"
            return Lines(
                headline: "バックアップに失敗しています。\(held)",
                aside: clip(why, 60),
                wantsAttention: true
            )
        }

        if all.approvals > 0 {
            let alsoRunning = running.isEmpty ? "" : "\(running.count)件が進行中。"
            return Lines(
                headline: "承認待ちが \(all.approvals)件あります。\(alsoRunning)",
                aside: "確認できるものが届いています。",
                wantsAttention: true,
                // Waiting, not wrong. The distinction is the whole reason this
                // colour exists.
                tone: .pending
            )
        }

        /**
         * Work that is running and should not still be.
         *
         * Above everything except an approval and a failed backup. A
         * delegated run has no stalled state — it stays `running` until its
         * deadline hours later — so nothing anywhere said "this started at
         * two in the morning and is still going". That is the shape of
         * failure this band exists for, and it was the one kind of work the
         * band could not report on.
         *
         * Forty minutes. Both benchmark runs finished inside six, and the
         * longest delegated run so far took four and a half; a run past forty
         * is not slow, it is stuck.
         */
        let longRunning = running.filter { run -> Bool in
            guard let started = run.startedAt else { return false }
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            guard let at = iso.date(from: started) ?? plain.date(from: started) else { return false }
            return Date().timeIntervalSince(at) > 40 * 60
        }

        if !longRunning.isEmpty || all.stalledRuns > 0 {
            var parts: [String] = []
            if let first = longRunning.first, let started = first.startedAt {
                let iso = ISO8601DateFormatter()
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let plain = ISO8601DateFormatter()
                plain.formatOptions = [.withInternetDateTime]
                if let at = iso.date(from: started) ?? plain.date(from: started) {
                    let minutes = Int(Date().timeIntervalSince(at) / 60)
                    let more = longRunning.count > 1 ? "、ほか \(longRunning.count - 1)件" : ""
                    parts.append("\(first.branch) が \(minutes)分 走り続けています\(more)。")
                }
            }
            if all.stalledRuns > 0 { parts.append("進捗の止まった実行が \(all.stalledRuns)件。") }
            return Lines(
                headline: parts.joined(separator: " "),
                aside: "⌥⌘D で内訳を確認できます。止めるならメニューから。",
                wantsAttention: true
            )
        }

        if !running.isEmpty {
            /**
             * Tokens, not dollars.
             *
             * The band said 費用は $2.15, and on a subscription no such money
             * moves — it is a figure Claude Code computes from token counts at
             * list prices. Putting it in front of somebody as a running total
             * invites them to think about a bill that does not exist, while
             * the quantity that genuinely drains is on the right of the same
             * band as a percentage of the week.
             *
             * Output tokens are what an agent spends. Shown in thousands
             * because the digit that matters is the leading one.
             */
            let out = all.runs.compactMap { $0.outputTokens }.reduce(0, +)
            let spent = out > 0 ? String(format: " 出力 %.1f千トークン。", Double(out) / 1000) : ""
            return Lines(
                headline: "\(running.count)件の作業が進行中。\(spent)",
                aside: next ?? "動いています。",
                wantsAttention: false
            )
        }

        if all.suggestions > 0 {
            return Lines(
                headline: "提案が \(all.suggestions)件あります。",
                aside: "次の一手を選べます。",
                wantsAttention: true
            )
        }

        /**
         * What is actually running, which the ledger does not know.
         *
         * The band said "着手中のものはありません" while six coding sessions were
         * open and one of them was mid-turn. Both statements were true about
         * different things: the ledger's In Progress column is a status
         * somebody sets by hand and nobody had, while the sessions are
         * observed. Saying the first and calling it the state of the work is
         * how a busy afternoon reads as a quiet one — which is the failure
         * this whole project exists to prevent.
         */

        /**
         * What is actually stopping, told apart from what is merely waiting.
         *
         * "止まっているものが 1件" became a name and the name did not help
         * either: 「Rating、Mastery、Coverageと自力再現結果を比較」 says which row
         * and nothing a person can act on. The one blocked task in this ledger
         * is not stuck at all — its dependency is finished and it is waiting
         * for a thirty-day observation window to close on 2026-08-28. A date
         * is the most useful thing that could be said about it, and "止まって
         * います" was the least true.
         *
         * So a blocked task whose notes carry a future date is reported as
         * waiting until that date. Anything else is genuinely stopped, and
         * then only the count appears here — the title was tried and did not
         * communicate, and the dashboard carries the reason underneath it.
         */
        struct Held { let untilAll: [Date]; let stuck: Int }
        let held: Held = {
            let blocked = projects.flatMap { $0.tasks ?? [] }.filter { $0.status == "Blocked" }
            var dates: [Date] = []
            var stuck = 0
            let form = DateFormatter()
            form.dateFormat = "yyyy-MM-dd"
            for task in blocked {
                // Any ISO date in the notes that has not passed. Written this
                // way because the ledger's prose is written by a person and
                // the only reliably machine-readable thing in it is the date.
                let text = task.notes
                var found: Date?
                var index = text.startIndex
                while let range = text.range(of: "\\d{4}-\\d{2}-\\d{2}", options: .regularExpression, range: index..<text.endIndex) {
                    if let date = form.date(from: String(text[range])), date > Date() {
                        if found == nil || date < found! { found = date }
                    }
                    index = range.upperBound
                }
                if let found { dates.append(found) } else { stuck += 1 }
            }
            return Held(untilAll: dates, stuck: stuck)
        }()

        /**
         * Not on the band unless something is actually stopped.
         *
         * A date that cannot move is not news. This would have sat on an
         * always-on surface for six days saying the same thing, which is how a
         * person learns to stop reading a line. It stays on the dashboard,
         * where things are looked at on purpose, and appears here only beside
         * work that is genuinely stuck.
         */
        let waiting: String = {
            guard held.stuck > 0, let soonest = held.untilAll.min() else { return "" }
            let day = DateFormatter()
            day.dateFormat = "M月d日"
            return " ほかに \(held.untilAll.count)件が \(day.string(from: soonest))まで待ち。"
        }()

        /**
         * 「詰まっている」では、どう詰まっているのか分からない。
         *
         * 数えているのは、台帳で `Blocked` になっていて**待ち先の日付が
         * 書かれていないもの** — つまり **いつ動くか分からない止まり方**。
         * 日付があるものは上の「◯月◯日まで待ち」に回る。二つを分けている
         * こと自体が読みなので、その違いを文に出す。
         */
        /**
         * 「いつ動くか分からない」は推測。書かない。
         *
         * 観測しているのは「`Blocked` で、メモに待ち先の日付が書かれて
         * いない」ことだけ。将来どうなるかは見ていない。
         */
        let stopped = held.stuck > 0 ? " 待ち先未定の作業が \(held.stuck)件。" : ""

        /**
         * How long, and where — the two things a person waiting actually wants.
         *
         * "2件が稼働中" says something is happening and leaves the reader with
         * no idea whether to keep waiting. The elapsed minutes and the project
         * name turn it into a decision: eleven minutes on `iris` is a long
         * answer in progress, eleven minutes on something you forgot you
         * started is a different situation.
         *
         * The same for a session that has stopped responding. "1件が反応して
         * いません" was asked "which one, and where do I look?" — the answer is
         * its directory, so the directory is what it says.
         */
        /**
         * 何分が何の何分なのかを書く。
         *
         * 「iris が 3分、ほか1件 作業中。」と出していて、**3分が何の3分なのか
         * どこにも書いていなかった** — 利用者いわく「意味がわからない」。
         * これは**いまのターンを始めてからの経過**で、待つかどうかを決める
         * ための数字。名前も、セッション自身の名前にする（`place` は
         * ディレクトリ名で、この機械では大半が `iris` になる）。
         */
        func describe(_ list: [Session], verb: String) -> String {
            guard let first = list.first else { return "" }
            let minutes = first.busyMinutes ?? first.idleMinutes
            let rest = list.count > 1 ? "。ほか \(list.count - 1)件" : ""
            return "\(first.name ?? first.place) \(verb) \(minutes)分\(rest)"
        }

        let busy = all.sessions
            .filter { $0.doing == "working" }
            .sorted { ($0.busyMinutes ?? 0) > ($1.busyMinutes ?? 0) }
        let stuckSessions = all.sessions
            .filter { $0.doing == "stalled" }
            .sorted { $0.idleMinutes > $1.idleMinutes }

        let doing: String = {
            var parts: [String] = []
            /**
             * 「考えています」をやめた。
             *
             * 何分が何の何分か書いていない、という指摘を直したときに、
             * **人間には使わない言い方に振れすぎた。**機械の内部状態を擬人化
             * すると、**淡々とした観測結果が「AI が自分を語っている画面」に
             * 変わる。**測っているのはターンの経過時間なので、そう言えばいい。
             */
            /**
             * 一覧と同じ語を使う。**同じ状態が二つの呼び名を持たない。**
             *
             * 「応答なし」は判定で、観測しているのは最後に書き込んでからの
             * 時間だけ。相手が死んでいるかどうかは見ていないので、そうは
             * 書かない。
             */
            if !busy.isEmpty { parts.append(describe(busy, verb: "実行中") + "。") }
            if !stuckSessions.isEmpty {
                parts.append(describe(stuckSessions, verb: "更新なし") + "。")
            }
            if parts.isEmpty {
                let idle = all.sessions.filter { $0.doing == "waiting" }.count
                // 「待機中」が誰を待っているのか書く。待っているのはこちらの返事。
                return idle > 0 ? "\(idle)件が こちらの返事を待っています。" : "動いているものはありません。"
            }
            return parts.joined(separator: " ")
        }()

        return Lines(
            headline: "\(doing)\(waiting)\(stopped)",
            aside: next ?? "予定はありません。",
            wantsAttention: false
        )
    }
}

private func clip(_ text: String, _ limit: Int) -> String {
    text.count <= limit ? text : String(text.prefix(limit)) + "…"
}

/**
 * A calendar or exam title, cut back to the part that identifies it.
 *
 * The band gets one line and the titles arrive carrying their filing:
 * 「病理学II25-26」 is a lecture range, 「微生物・免疫学試験（後半）」 a half. Neither
 * tells the reader anything they do not already know by the time they are
 * looking — the subject is what they are checking for, and the numbers push
 * the next field off the edge. On 2026-08-26 the exam title was being clipped
 * mid-parenthesis to 「微生物・免疫学試験 (後半…」, which is the worst of both:
 * the detail is unreadable and the space is spent anyway.
 *
 * Two suffixes go. A trailing parenthesis, closed or already cut off by an
 * earlier clip; and trailing arabic numerals, including a range. Roman
 * numerals stay: 「病理学II」 and 「病理学I」 are different subjects, and dropping
 * the II would merge two things a person keeps apart.
 *
 * Everything else is left exactly as written. A title that carries no filing
 * is returned unchanged, and one that is nothing but numbers keeps them —
 * removing every character is not shortening.
 */
private func subject(_ title: String) -> String {
    var text = title
    for pattern in [
        // 「…（後半）」「…(後半」 — a parenthetical tail, whether or not it closed.
        "[\\s]*[（(][^）)]*[）)]?[\\s]*$",
        // 「…25-26」「…21」 — a lecture number or a range of them.
        "[\\s]*[0-9０-９]+(?:[-‐‑–—~〜][0-9０-９]+)?[\\s]*$",
    ] {
        guard let range = text.range(of: pattern, options: .regularExpression) else { continue }
        let trimmed = String(text[text.startIndex..<range.lowerBound])
        // Removing everything is not shortening.
        if !trimmed.trimmingCharacters(in: .whitespaces).isEmpty { text = trimmed }
    }
    return text.trimmingCharacters(in: .whitespaces)
}

/// The band's own surface, so a press that the window does receive has
/// somewhere to land. Whether it does is measured, not assumed.
final class Pressable: NSView {
    var onPress: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onPress?() }
}

/// Two short marks bounding the pressable end of the band.
final class BandCorner: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /**
     * The bracket that bounds the pressable end, and a graduated arc.
     *
     * The bracket alone said "this part is a target". The arc says what the
     * core is — an instrument with a scale around it rather than a picture in
     * a corner. It carries nothing; the web core has the same furniture for
     * the same reason, and the two surfaces should look like one object.
     *
     * Drawn behind the core, open at the left and right so it reads as a
     * scale rather than a ring.
     */
    override func draw(_ dirtyRect: NSRect) {
        guard let c = NSGraphicsContext.current?.cgContext else { return }

        let centre = CGPoint(x: bounds.minX + 37, y: bounds.midY)
        let radius: CGFloat = 27

        // Graduation: twenty-four marks, every third longer, and the ones on
        // the horizontal left out so the arc opens rather than closes.
        for i in 0..<24 {
            let angle = CGFloat(i) * .pi / 12
            let flat = abs(sin(angle)) < 0.35
            if flat { continue }
            let long = i % 3 == 0
            let inner = radius
            let outer = radius + (long ? 4.5 : 2.5)
            c.setStrokeColor(Palette.accent.withAlphaComponent(long ? 0.30 : 0.14).cgColor)
            c.setLineWidth(long ? 0.9 : 0.6)
            c.move(to: CGPoint(x: centre.x + cos(angle) * inner, y: centre.y + sin(angle) * inner))
            c.addLine(to: CGPoint(x: centre.x + cos(angle) * outer, y: centre.y + sin(angle) * outer))
            c.strokePath()
        }

        // Two arcs, top and bottom, stopping short of the horizontal.
        c.setStrokeColor(Palette.accent.withAlphaComponent(0.22).cgColor)
        c.setLineWidth(1)
        for base in [CGFloat.pi / 2, -CGFloat.pi / 2] {
            c.addArc(center: centre, radius: radius + 7, startAngle: base - 0.9, endAngle: base + 0.9, clockwise: false)
            c.strokePath()
        }

        /**
         * A rule, not a bracket.
         *
         * This drew three sides of a box at the right edge of the handle,
         * which is the shape of a `]` — and a closing bracket with nothing
         * opening it reads as a typo rather than as a boundary. The band's
         * left edge is the screen's edge; there is nowhere to put the `[`.
         *
         * A plain vertical rule says the same thing without implying a missing
         * half, and it matches the rules already separating the weather from
         * the allowance at the other end.
         */
        c.setStrokeColor(Palette.Band.rule.cgColor)
        c.setLineWidth(1)
        let x = bounds.maxX - 1
        c.move(to: CGPoint(x: x, y: bounds.minY + 18))
        c.addLine(to: CGPoint(x: x, y: bounds.maxY - 18))
        c.strokePath()
    }
}

final class Strip: NSPanel {
    var onPress: (() -> Void)?
    private let headline = NSTextField(labelWithString: "")
    private let aside = NSTextField(labelWithString: "")
    private let mark = NSTextField(labelWithString: "IRIS")
    private let core = CoreView()
    /// The right end. Empty until there is weather, and never invented.
    private let sky = NSTextField(labelWithString: "")
    private let skyRule = NSView()
    /// What is left of each week's allowance, in the same row as the weather.
    private let allowance = NSTextField(labelWithString: "")
    private let allowanceRule = NSView()
    /// The countdown. Always present, which is the whole reason for it.
    private let exam = NSTextField(labelWithString: "")
    private let examRule = NSView()

    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        /**
         * Pass-through, except over the handle.
         *
         * A band across the whole top that swallowed clicks would be in the way
         * of the work it reports on — the top of the screen is where an
         * application keeps its tabs. But a separate watcher that only *sees*
         * the press does not stop it: the click went to the handle and to the
         * button underneath it, both. Observing is not consuming.
         *
         * So the window itself takes the click, and only while the pointer is
         * over the left end. `setHandleActive` is driven by a pointer monitor;
         * everywhere else this stays true and nothing changes.
         */
        ignoresMouseEvents = true
        isFloatingPanel = true
        hidesOnDeactivate = false

        /**
         * Dark, always, regardless of what the system is set to.
         *
         * The first version used the system materials and semantic label
         * colours, which meant the band took its appearance from the light
         * theme and then sat on top of a light application — pale text on a
         * pale ground, unreadable in exactly the situation it was built for.
         * A strip that reports on IRIS should look like IRIS, and a dark band
         * separates itself from a light app and a dark one alike.
         */
        appearance = NSAppearance(named: .darkAqua)

        /**
         * Opaque, and the application's own ground colour.
         *
         * It was translucent first, which meant the band took on whatever was
         * behind it — over a light application the text washed out, in exactly
         * the situation the strip exists for. Blur is only worth having when
         * what is behind it is predictable, and here it never is.
         */
        let blur = Pressable()
        blur.onPress = { [weak self] in self?.onPress?() }
        blur.wantsLayer = true
        blur.layer?.backgroundColor = Palette.Band.ground.cgColor
        contentView = blur

        // The same corner marks as the square, on the end that is pressed. It
        // is the one part of the band that is a control, and a bracket around
        // it is the difference between text and a target.
        let corner = BandCorner()
        corner.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(corner)
        NSLayoutConstraint.activate([
            corner.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
            corner.topAnchor.constraint(equalTo: blur.topAnchor),
            corner.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            corner.widthAnchor.constraint(equalToConstant: Strip.handleWidth),
        ])

        // A hairline where the band ends, in `--hud-line`. Without it the band
        // and a dark application below it are one continuous field.
        let edge = NSView()
        edge.wantsLayer = true
        // Cyan rather than the panel's neutral line: the one lit edge of a
        // dark strip is what says the strip is a display and not a shadow.
        edge.layer?.backgroundColor = Palette.Band.edge.cgColor
        edge.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(edge)
        NSLayoutConstraint.activate([
            edge.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
            edge.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
            edge.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            edge.heightAnchor.constraint(equalToConstant: 1),
        ])

        mark.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        mark.textColor = Palette.mark
        // The one flourish, and it is the product's own mark rather than
        // decoration: letterspaced small caps, the way it is set in the app.
        /**
         * The name, lit rather than labelled.
         *
         * Ten points of dim grey was a caption on a widget. This is the same
         * light the core is made of, at a size that makes the left end of the
         * band read as one object — a core, its name, and a bracket around
         * both — instead of an icon with a note beside it.
         */
        mark.attributedStringValue = NSAttributedString(
            string: "IRIS",
            attributes: [
                /**
                 * Halfway to the web core's centre mark, which is what was
                 * asked for. That one is set at four percent of a core over a
                 * thousand points across — far too large here — and this was
                 * ten points of grey caption, which was far too small. Both
                 * are the same monospace at the same 0.5em tracking now, so
                 * the two surfaces read as one typeface at two sizes.
                 */
                /**
                 * The system face, light, at the same tracking as the core's
                 * centre mark — one typeface across both surfaces, with the
                 * weight chosen by the size. Seventeen points of ultra-light
                 * is a smear; fifty-eight points of bold is a headline.
                 */
                .font: NSFont.systemFont(ofSize: 16, weight: .medium),
                .kern: 4.6,
                .foregroundColor: Palette.Band.headline,
                .shadow: {
                    let glow = NSShadow()
                    glow.shadowColor = Palette.accent.withAlphaComponent(0.28)
                    glow.shadowBlurRadius = 6
                    glow.shadowOffset = .zero
                    return glow
                }(),
            ]
        )

        // Literal colours, not semantic ones: `.labelColor` follows the system
        // theme, and the whole point is that this band does not.
        headline.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        headline.textColor = Palette.Band.headline
        aside.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        /**
         * Brought up to the row on the right.
         *
         * This line carries today's and tomorrow's appointments, which is
         * read as often as anything on the band — and it was a step dimmer
         * than the figures at the other end for no reason beyond being the
         * second line of a stack. The hierarchy is still there: the headline
         * is a paler, whiter cyan, and this is the accent proper.
         */
        aside.textColor = Palette.Band.emphasis
        for label in [mark, headline, aside] {
            label.lineBreakMode = .byTruncatingTail
            label.translatesAutoresizingMaskIntoConstraints = false
            blur.addSubview(label)
        }

        /**
         * The right end, which was empty.
         *
         * It stayed empty on purpose for a while: a band that fills its space
         * with whatever is available ends up reporting nothing in particular.
         * The weather earns the place because it is the one thing here that is
         * about the room rather than about the work — glanced at, never acted
         * on, and wrong to put in the sentence the headline is making.
         *
         * A hairline separates it, so the two halves read as two statements
         * rather than one that ran long.
         */
        sky.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        sky.textColor = Palette.Band.aside
        sky.alignment = .right
        sky.lineBreakMode = .byTruncatingTail
        sky.translatesAutoresizingMaskIntoConstraints = false
        // Holds its width against the headline rather than being squeezed to
        // nothing by it: a truncated forecast beside a truncated sentence is
        // two unreadable things instead of one.
        sky.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(800), for: .horizontal)
        sky.setContentHuggingPriority(NSLayoutConstraint.Priority(800), for: .horizontal)
        blur.addSubview(sky)

        /**
         * The two allowances, beside the weather rather than instead of it.
         *
         * Codex's reading of the right end was that a single wide label is the
         * wrong shape for it — better a right-aligned group of small blocks
         * with rules between, each answering a different question. It also
         * suggested hiding this one until it crosses a threshold; that was
         * overruled, because a number you only see when it is already a
         * problem cannot be watched, and watching it is the point.
         */
        exam.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        exam.textColor = Palette.Band.aside
        exam.alignment = .right
        exam.lineBreakMode = .byTruncatingTail
        exam.translatesAutoresizingMaskIntoConstraints = false
        exam.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(900), for: .horizontal)
        exam.setContentHuggingPriority(NSLayoutConstraint.Priority(900), for: .horizontal)
        blur.addSubview(exam)

        examRule.wantsLayer = true
        examRule.layer?.backgroundColor = Palette.Band.rule.cgColor
        examRule.translatesAutoresizingMaskIntoConstraints = false
        examRule.isHidden = true
        blur.addSubview(examRule)

        allowance.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        allowance.textColor = Palette.Band.aside
        allowance.alignment = .right
        allowance.lineBreakMode = .byTruncatingTail
        allowance.translatesAutoresizingMaskIntoConstraints = false
        /**
         * Never the one that gives way.
         *
         * All four blocks along the band sat at `.defaultHigh`, which means
         * the layout engine picks whichever it likes when they do not fit —
         * and it picked this one, so the allowance simply vanished. They are
         * ranked now, right to left: the allowance holds absolutely, the exam
         * next, the forecast after that, and the sentence in the middle is
         * what truncates. That order is the order they are wanted in when
         * there is not enough room.
         */
        allowance.setContentCompressionResistancePriority(.required, for: .horizontal)
        allowance.setContentHuggingPriority(.required, for: .horizontal)
        blur.addSubview(allowance)

        allowanceRule.wantsLayer = true
        allowanceRule.layer?.backgroundColor = Palette.Band.rule.cgColor
        allowanceRule.translatesAutoresizingMaskIntoConstraints = false
        allowanceRule.isHidden = true
        blur.addSubview(allowanceRule)

        skyRule.wantsLayer = true
        skyRule.layer?.backgroundColor = Palette.Band.rule.cgColor
        skyRule.translatesAutoresizingMaskIntoConstraints = false
        skyRule.isHidden = true
        blur.addSubview(skyRule)

        // The sentence yields first. It is the longest thing here and the
        // only one that still means something when its tail is cut.
        for label in [headline, aside] {
            label.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(250), for: .horizontal)
        }

        let text = NSStackView(views: [headline, aside])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(text)

        core.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(core)

        NSLayoutConstraint.activate([
            core.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 12),
            core.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            core.widthAnchor.constraint(equalToConstant: 50),
            core.heightAnchor.constraint(equalToConstant: 50),

            mark.leadingAnchor.constraint(equalTo: core.trailingAnchor, constant: 12),
            mark.centerYAnchor.constraint(equalTo: blur.centerYAnchor),

            text.leadingAnchor.constraint(equalTo: mark.trailingAnchor, constant: 14),
            text.centerYAnchor.constraint(equalTo: blur.centerYAnchor),

            // Widened from 300: the forecast gained a sentence about rain and
            // was losing it to the ellipsis.
            // Usage at the far right, weather inboard of it. The allowance is
            // the figure with a decision attached to it, and the end of a line
            // is where the eye stops.
            allowance.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -20),
            allowance.centerYAnchor.constraint(equalTo: blur.centerYAnchor),

            allowanceRule.trailingAnchor.constraint(equalTo: allowance.leadingAnchor, constant: -14),
            allowanceRule.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            allowanceRule.widthAnchor.constraint(equalToConstant: 1),
            allowanceRule.heightAnchor.constraint(equalToConstant: 18),

            sky.trailingAnchor.constraint(equalTo: allowanceRule.leadingAnchor, constant: -14),
            sky.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            sky.widthAnchor.constraint(lessThanOrEqualToConstant: 430),

            skyRule.trailingAnchor.constraint(equalTo: sky.leadingAnchor, constant: -14),
            skyRule.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            skyRule.widthAnchor.constraint(equalToConstant: 1),
            skyRule.heightAnchor.constraint(equalToConstant: 18),

            exam.trailingAnchor.constraint(equalTo: skyRule.leadingAnchor, constant: -14),
            exam.centerYAnchor.constraint(equalTo: blur.centerYAnchor),

            examRule.trailingAnchor.constraint(equalTo: exam.leadingAnchor, constant: -14),
            examRule.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            examRule.widthAnchor.constraint(equalToConstant: 1),
            examRule.heightAnchor.constraint(equalToConstant: 18),

            text.trailingAnchor.constraint(lessThanOrEqualTo: examRule.leadingAnchor, constant: -14),
        ])
        core.start()

        place()
        NotificationCenter.default.addObserver(
            self, selector: #selector(place),
            name: NSApplication.didChangeScreenParametersNotification, object: nil
        )
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /**
     * Under the menu bar, and at the top of the screen when there is not one.
     *
     * `visibleFrame` is exactly that distinction: it excludes the menu bar and
     * the Dock when they are there, and covers the whole screen when they are
     * not. So the same expression puts the strip below the clock in an ordinary
     * desktop and flush to the top edge inside a full-screen app, which is what
     * "the top of the screen" means in each case.
     */
    @objc func place() {
        guard let screen = NSScreen.main else { return }
        /**
         * Full width from `frame`, top edge from `visibleFrame`.
         *
         * Both were taken from `visibleFrame`, which is right for the vertical
         * placement — it is exactly what puts the band under the menu bar when
         * there is one and flush to the top edge inside a full-screen app —
         * and wrong for the width. `visibleFrame` also subtracts the Dock, and
         * this Dock is on the right, so the band stopped sixty-odd points
         * short of the screen edge and left a notch of whatever was behind it
         * showing. A band across the top should reach both ends of the top.
         *
         * It draws over the Dock's upper corner as a result. The Dock centres
         * its icons, so that corner is empty in every ordinary case.
         */
        let full = screen.frame
        let visible = screen.visibleFrame
        /**
         * Fifty-eight, up from fifty.
         *
         * Eight points buys a core large enough to be the thing you look at
         * rather than a marker beside the text, and a wordmark that reads as a
         * name. The band still covers less than five percent of a laptop
         * screen, and what it covers was the menu bar's own margin.
         */
        let height: CGFloat = 58
        setFrame(
            NSRect(x: full.minX, y: visible.maxY - height, width: full.width, height: height),
            display: true
        )
    }

    func setCoreStill(_ still: Bool) { core.animates = !still }

    /**
     * Says the microphone is open, while it is open.
     *
     * The one thing a person must be able to see without asking. It overrides
     * whatever the band was reporting, because nothing else on it matters as
     * much as whether it is listening right now.
     */
    private var speaking = false
    private var lastSnapshot: Snapshot?

    func saySpeaking(_ on: Bool) {
        speaking = on
        core.pace = on ? 2.2 : 1.0
        if on {
            headline.stringValue = "聞いています。どうぞ。"
            headline.textColor = Palette.accent
            aside.stringValue = "キーを離すと送ります。"
            return
        }
        /**
         * Put back what was there.
         *
         * Clearing the flag was not enough: `show` is the only thing that
         * writes the labels and it runs on a 45-second poll, so releasing the
         * key left "聞いています。" on screen for up to three quarters of a
         * minute — saying it was listening when it had stopped, which is the
         * one thing this line must never get wrong.
         */
        if let last = lastSnapshot { show(last) }
    }

    /// Said while the recogniser is starting, before it can hear anything.
    func sayPreparing() {
        speaking = true
        core.pace = 1.6
        headline.stringValue = "準備中…"
        headline.textColor = Palette.Band.aside
        aside.stringValue = "「聞いています」に変わってから話してください。"
    }

    /// Said between releasing the key and anything being recognised.
    func sayThinking() {
        headline.stringValue = "聞き取っています…"
        headline.textColor = Palette.accent
        aside.stringValue = ""
    }

    /**
     * What it heard, before what it makes of it.
     *
     * A microphone hears the room. Push-to-talk treats everything inside the
     * press as addressed, so a television speaking during it becomes a request
     * — which happened, and the first sign was a sensible answer to a sentence
     * nobody had said. By the time an answer arrives it is too late to notice
     * cheaply.
     *
     * Showing the transcript first makes a mis-hearing obvious in the second it
     * occurs, at no cost: the words are already there, and they were being
     * thrown away in favour of "考えています…".
     */
    func sayHeard(_ text: String) {
        headline.stringValue = "「\(clip(text, 34))」"
        headline.textColor = Palette.accent
        aside.stringValue = "考えています…"
    }

    /**
     * The answer, and it stays.
     *
     * It was written and then overwritten in the same instant: the reply went
     * up, `refresh` ran, and the snapshot replaced it before anyone could read
     * a word. A reply that appears for one frame is worse than none, because
     * the person knows something was there.
     *
     * So it holds. Forty seconds is long enough to read two lines and short
     * enough that the band goes back to reporting on its own — a reply left
     * there permanently would eventually be describing a question nobody
     * remembers asking.
     */
    private var holdingUntil: Date?

    func sayAnswer(_ heard: String, _ reply: String) {
        headline.stringValue = clip(heard, 40)
        headline.textColor = Palette.headline
        // Two lines is all there is. The whole reply is in the panel that
        // ⌥⌘A opens, and the band says so when there is more than fits.
        let flat = reply.replacingOccurrences(of: "\n", with: " ")
        aside.stringValue = flat.count > 64 ? clip(flat, 64) + "  ⌥⌘A で全文" : flat
        holdingUntil = Date().addingTimeInterval(40)
    }

    /**
     * The right end, set apart from everything else the band says.
     *
     * Written outside `show`'s early returns on purpose. The headline belongs
     * to whatever is happening now and gets taken over by the microphone and
     * by replies; the weather belongs to the hour and has no business
     * disappearing because someone held a key down.
     *
     * A failure is printed rather than hidden. An empty corner reads as a
     * still afternoon, and the actual meaning is almost always that the
     * shortcut this depends on was renamed or deleted — a thing nobody would
     * ever go looking for, because nothing would be missing.
     */
    private func setWeather(_ weather: Weather?) {
        guard let weather else {
            // No answer at all from the endpoint. The band already says it
            // cannot reach IRIS; saying it twice at opposite ends is noise.
            sky.stringValue = ""
            skyRule.isHidden = true
            return
        }
        if let text = weather.text, !text.isEmpty {
            sky.stringValue = clip(text, 28)
            // The same brightness as the exam and the allowance beside it.
            // Three blocks in one row, read at a glance, should not have one
            // of them sitting a step further back for no reason.
            sky.textColor = Palette.Band.emphasis
            sky.toolTip = text
        } else {
            sky.stringValue = "天気を取得できません"
            sky.textColor = Palette.Band.aside
            sky.toolTip = weather.reason
        }
        skyRule.isHidden = false
    }

    /**
     * Both allowances, or the fact that one of them is not being reported.
     *
     * Codex's is read from its own session files and is always there; Claude's
     * is relayed by a status line that only runs in a terminal, so it is
     * routinely absent. Written as `—` rather than omitted: a row with one
     * figure on it looks like a machine with one assistant.
     */
    /**
     * 使用量は帯から外した。レール（⌥⌘R）にある。
     *
     * It read `usage  CLAUDE 34%  CODEX 11%`, and two things were wrong with
     * that. The numbers are the fraction *used* and nothing on the line said
     * so, which is how a session came to treat 0% as "nothing left". And the
     * same figures now sit on the rail as rings, where empty and full cannot
     * be confused — the same number in two places means one of them is the
     * stale one, which is most of what this week was spent fixing.
     *
     * Kept as an empty function rather than deleted so the call sites read as
     * a deliberate absence instead of looking like something was forgotten.
     */
    private func setAllowance(_ usage: CliUsage?) {
        allowance.stringValue = ""
        allowanceRule.isHidden = true
    }

    /**
     * The countdown, and the colour it turns as it runs out.
     *
     * Days rather than a date, because the question is never "when is it" —
     * it is "how much time is left", and a date makes the reader do the
     * subtraction every time they glance at it.
     */
    private func setExam(_ next: NextExam?) {
        guard let next else {
            exam.stringValue = ""
            examRule.isHidden = true
            return
        }
        let when = next.days == 0 ? "今日" : "あと \(next.days)日"
        exam.stringValue = "\(clip(subject(next.title), 12))  \(when)"
        exam.textColor = next.days <= 1 ? Palette.attention : next.days <= 4 ? Palette.Band.emphasis : Palette.Band.aside
        examRule.isHidden = false
    }

    /// The width of the left end that answers to the pointer.
    /**
     * Wide enough that the rule at its edge clears the wordmark.
     *
     * At 132 the line landed against the S — `R I S|` — which reads as a
     * stray glyph rather than a boundary. The mark is seventeen points at
     * 7.5 kern and starts after a fifty-point core, so the rule needs to sit
     * past 150.
     */
    static let handleWidth: CGFloat = 168

    /// True while the pointer is over the handle, false everywhere else.
    func setHandleActive(_ active: Bool) {
        guard ignoresMouseEvents == active else { return }
        ignoresMouseEvents = !active
    }

    /**
     * Gets out of the way when reached for.
     *
     * Clicks passing through was only half of not being in the way. The band
     * still occupies the top fifty points of the screen, and macOS does not
     * know it is there — `visibleFrame` accounts for the menu bar and the Dock
     * and nothing else — so a maximised window goes underneath it and its tabs
     * and its close button are covered. Invisible to the mouse is not the same
     * as out of the way to the eye.
     *
     * So it yields. Reaching into the band fades it to almost nothing, which is
     * exactly when its content is not what is wanted; moving away brings it
     * back. The handle end stays solid, because that is the one part that is
     * reached for on purpose.
     */
    func setYielding(_ yielding: Bool) {
        /**
         * All the way out of the way.
         *
         * It faded to a tenth first, which is enough to read a window title
         * through but not enough to stop the band being the thing you see. The
         * point of yielding is that what is underneath becomes usable, and a
         * ghost over an application's tabs is still over them.
         *
         * Invisible is safe here: the window already ignores mouse events
         * everywhere but the handle, and moving away brings it back.
         */
        let target: CGFloat = yielding ? 0.0 : 1.0
        guard abs(alphaValue - target) > 0.01 else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = yielding ? 0.12 : 0.34
            animator().alphaValue = target
        }
    }

    func show(_ snapshot: Snapshot) {
        lastSnapshot = snapshot
        // Before the early returns: see `setWeather`. This end of the band is
        // not part of the sentence the other end is making.
        if case let .ready(all) = snapshot {
            setWeather(all.weather)
            setAllowance(all.usage)
            setExam(all.exam)
        } else {
            setWeather(nil)
            setAllowance(nil)
            setExam(nil)
        }
        // While the key is held the band says so and nothing else.
        if speaking { return }
        // And an answer that has just arrived is not pushed aside by a poll.
        if let until = holdingUntil {
            if Date() < until { return }
            holdingUntil = nil
        }
        let l = lines(for: snapshot)
        headline.stringValue = l.headline
        aside.stringValue = l.aside
        headline.textColor = l.wantsAttention
            ? (l.tone == .pending ? Palette.Band.pending : Palette.attention)
            : Palette.Band.headline

        /**
         * The ring says what the words say, before they are read.
         *
         * Same idea as the real core: one hue throughout, and only the pace and
         * the brightness carry the state. Unreachable is the one that dims
         * rather than slows — a dark, still ring is what nothing looks like.
         */
        switch snapshot {
        case .unreachable:
            core.pace = 0.2
            core.brightness = 0.25
        case .unreadable:
            core.pace = 0.6
            core.brightness = 0.7
        case let .ready(all):
            let working = all.runs.contains { $0.state == "running" }
            core.pace = working ? 2.6 : (l.wantsAttention ? 1.5 : 1.0)
            core.brightness = working ? 1.25 : 1.0
        }
    }
}



// MARK: - The dashboard

/**
 * A square, drawn rather than assembled.
 *
 * The first version of this was a stack of labels and a bar, and it looked like
 * a settings pane — which is what a stack of system controls always looks like.
 * The instrument this borrows from is drawn: rings, arcs, rules, and numbers
 * set in a monospace so they hold their columns. So everything here is one
 * custom view with a `draw`, and the only system control is the window itself.
 *
 * Square because a dial is round and two of them side by side want equal room
 * above and below. The proportion is the point, not a preference.
 */
final class Dashboard: NSPanel {
    private let face = Face()
    private var scroll: NSScrollView?
    private var faceHeight: NSLayoutConstraint?
    private let approve = NSButton(title: "承認して実行", target: nil, action: nil)
    private let refuse = NSButton(title: "拒否", target: nil, action: nil)
    /**
     * The settings, here rather than only in the status item.
     *
     * They lived in the menu bar menu, which macOS hides inside a full-screen
     * app — the same failure the band was built to fix, and the third surface
     * it has now happened on. This panel is reachable by a key and by the
     * band's own handle, both of which work in full screen.
     */
    private let listen = NSButton(title: "", target: nil, action: nil)
    private let motion = NSButton(title: "", target: nil, action: nil)
    var ambient: () -> Bool = { false }
    var stillCore: () -> Bool = { false }
    var onListen: (() -> Void)?
    var onMotion: (() -> Void)?
    private var deciding: PendingApproval?
    /// Set by the controller; the panel does not talk to the server itself.
    var onDecision: ((String, Bool) -> Void)?

    init() {
        let saved = UserDefaults.standard.string(forKey: "board.frame")
        let start = saved.map(NSRectFromString) ?? NSRect(x: 140, y: 140, width: 380, height: 640)
        super.init(
            contentRect: start,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        appearance = NSAppearance(named: .darkAqua)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        /**
         * 窓そのものを面の色にする。
         *
         * 黒を窓の背景にして、面は別の層で塗っていた。**層が一枚でも欠けると
         * 黒が出る**という作りで、実際に二度出した。角丸は macOS が窓に
         * 付けるので、こちらで黒い縁を作る必要も無い — 参考画像の外側の黒は、
         * **黒い机の上で撮った写真**であって、盤の部品ではない。
         *
         * こうすると、どの層が抜けても盤は `#06070A` のまま。
         */
        backgroundColor = Palette.Board.ground
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isFloatingPanel = true
        hidesOnDeactivate = false
        // Square, and kept square: a dial that goes oval stops reading as a dial.
        minSize = NSSize(width: 300, height: 260)
        /**
         * 正方形をやめた。
         *
         * 「盤が丸いから、二つ並べれば上下に同じ余白が要る」というのが理由
         * だった。**その二つの盤はもう無い**（使用量はレールへ移した）。
         * 残っているのは文と一覧で、どちらも横より縦に伸びたい。正方形の
         * ままだと、**幅が足りず文が窓の外で切れる。**
         */
        maxSize = NSSize(width: 560, height: 1200)

        /**
         * Scrollable, because the content grew past the square.
         *
         * Sessions, dials, gauges, counters and a decision do not fit in 340
         * points, and the first version simply drew past the bottom: the dials
         * ended up underneath the buttons and nothing could be reached. A fixed
         * square with variable content has to scroll or it has to lie about how
         * much there is.
         */
        /**
         * 面は窓が描く。**巻物の中身ではなく。**
         *
         * `Face` が角丸の面を塗っていたが、`Face` は巻物の中身なので
         * **内容の高さと同じだけしか無い。**内容が窓より短いと、その下は
         * 塗られず黒が出る（「下の何割かが死んでる」）。長ければ角丸が
         * 巻き上がって消える。面は窓に固定されているものなので、窓の側で
         * 一度だけ塗る。
         */
        let shell = BoardShell()
        shell.translatesAutoresizingMaskIntoConstraints = false
        if let host = contentView {
            host.addSubview(shell)
            NSLayoutConstraint.activate([
                shell.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                shell.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                shell.topAnchor.constraint(equalTo: host.topAnchor),
                shell.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            ])
        }

        let scroll = NSScrollView()
        /**
         * 巻物も、その中の切り抜き窓も、背景を描かせない。
         *
         * `NSScrollView.drawsBackground = false` だけでは足りない。**中の
         * `NSClipView` が自分の背景を持っていて**、既定では描く — それが
         * 後ろの面を覆っていた。面が窓を覆えていなかったのではなく、
         * **覆っていたものが上から塗り潰されていた。**
         */
        scroll.drawsBackground = false
        scroll.backgroundColor = .clear
        scroll.contentView.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        /**
         * The width comes from a constraint, not from reading `contentSize`.
         *
         * It was read at the moment a snapshot arrived, which is before the
         * scroll view has been laid out — so the face was sized from a number
         * that was not yet true, and everything centred on `bounds.midX` landed
         * off the left edge while the things pinned to `pad` looked fine. Tied
         * to the clip view, the width is right whenever it is right, including
         * on resize, with nothing to read at the wrong moment.
         */
        face.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = face
        NSLayoutConstraint.activate([
            face.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            face.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            face.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
        ])
        faceHeight = face.heightAnchor.constraint(equalToConstant: 400)
        faceHeight?.isActive = true
        // The drawing reports its own extent, so the scrollable height and the
        // drawn height cannot disagree.
        face.onHeight = { [weak self] height in
            self?.faceHeight?.constant = max(200, height)
        }
        scroll.translatesAutoresizingMaskIntoConstraints = false
        contentView?.addSubview(scroll)
        if let host = contentView {
            NSLayoutConstraint.activate([
                // Below the window buttons. They are drawn by the system over
                // whatever is there, and the wordmark was underneath them.
                scroll.topAnchor.constraint(equalTo: host.topAnchor, constant: 30),
                scroll.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                scroll.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                /**
                 * 下に84ポイント空けていた。**これが黒い帯の正体。**
                 *
                 * 承認/却下の釦と、設定の二つを置くための場所だった。設定は
                 * 献立へ移して隠し、承認は判断待ちのときしか出ない。**出ない
                 * ものの場所を常に空けていた**ので、盤の下がいつも黒かった。
                 *
                 * 切り抜き窓の背景も、無い中身の高さも、それぞれ本当の不具合
                 * だったが、**この帯はそれとは別に、ずっとここにあった。**
                 */
                scroll.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -10),
            ])
        }
        self.scroll = scroll

        // Minimise and zoom mean nothing for a panel held square. Close stays:
        // it is the only way out that does not require remembering a shortcut.
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        /**
         * The two buttons, and why they are here at all.
         *
         * The advice was to keep state changes off a small always-present
         * surface, and the reasoning — that people approve without reading when
         * approving is easy — is right. What makes it survivable here is that
         * there is now something to read: the tool writes a sentence saying
         * what the call does, and that sentence is above these buttons. A
         * button with a summary over it is a different object from a button.
         *
         * Anything the sentence does not cover still goes to the application,
         * and the row says so.
         */
        for button in [approve, refuse] {
            button.bezelStyle = .rounded
            button.isHidden = true
            button.target = self
            button.translatesAutoresizingMaskIntoConstraints = false
            contentView?.addSubview(button)
        }
        approve.action = #selector(allow)
        refuse.action = #selector(deny)

        for button in [listen, motion] {
            button.bezelStyle = .inline
            button.isBordered = false
            button.target = self
            button.translatesAutoresizingMaskIntoConstraints = false
            button.contentTintColor = Palette.aside
            contentView?.addSubview(button)
        }
        /**
         * 設定の行は盤から外した。
         *
         * 下端に切り替えが二つ並んでいると、**盤が設定画面に見える。**同じ
         * ものはメニューバーの献立にある。生成だけ残してあるのは
         * `refreshSettings` の呼び出し側を消さずに済ませるため。
         */
        listen.isHidden = true
        motion.isHidden = true
        listen.action = #selector(toggleListen)
        motion.action = #selector(toggleMotion)
        if let host = contentView {
            NSLayoutConstraint.activate([
                listen.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 18),
                listen.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -18),
                motion.leadingAnchor.constraint(equalTo: listen.trailingAnchor, constant: 16),
                motion.bottomAnchor.constraint(equalTo: listen.bottomAnchor),
            ])
        }
        approve.keyEquivalent = ""
        if let host = contentView {
            NSLayoutConstraint.activate([
                approve.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -18),
                approve.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -46),
                refuse.trailingAnchor.constraint(equalTo: approve.leadingAnchor, constant: -8),
                refuse.bottomAnchor.constraint(equalTo: approve.bottomAnchor),
            ])
        }

        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(remember), name: name, object: self
            )
        }
        // Re-laid out on resize. The face is sized to the scroll view's width
        // when the snapshot arrives, and without this it keeps the width it had
        // when the panel opened — drawing off the side of a narrowed window.
        NotificationCenter.default.addObserver(
            self, selector: #selector(relayout),
            name: NSWindow.didResizeNotification, object: self
        )
    }

    override var canBecomeKey: Bool { true }

    @objc private func relayout() {
        show(face.snapshot)
    }

    @objc private func remember() {
        UserDefaults.standard.set(NSStringFromRect(frame), forKey: "board.frame")
    }

    func show(_ snapshot: Snapshot) {
        /**
         * 課題を押したら IRIS の課題欄へ。
         *
         * 盤は要るものを要る順に五行出すだけで、**中身を読み書きする場所は
         * ウェブの側**。番号を持っていくので、開いた先で探し直さずに済む。
         */
        /**
         * 行を押したら、その作業の出どころを開く。
         *
         * Claude は `claude://code/continue?session=<id>`。この形は
         * Claude.app の中に実在するが、**`session` が特定の id を受けるかは
         * 確かめられていない**（見つかったのは `session=last` の用例だけ）。
         * 開かなければ何も起きない — **開いたふりはしない。**
         */
        face.onWork = { door in
            switch door {
            case let .url(url):
                NSWorkspace.shared.open(url)
            case let .app(path):
                /**
                 * 走っているものがあれば、それを前に出す。無ければ開く。
                 *
                 * `openApplication` は起動していれば前に出すが、**窓が
                 * 隠れているだけの場合に確実ではない。**走っている実体を
                 * 名指しで起こす方が確か。識別子は束から読む — IRIS は
                 * Safari の web アプリで、作り直すたびに変わるので。
                 */
                let url = URL(fileURLWithPath: path)
                if let identifier = Bundle(url: url)?.bundleIdentifier,
                   let running = NSRunningApplication
                       .runningApplications(withBundleIdentifier: identifier).first {
                    running.activate(options: [.activateAllWindows])
                    return
                }
                guard FileManager.default.fileExists(atPath: path) else { return }
                NSWorkspace.shared.openApplication(at: url, configuration: .init())
            case let .shell(command):
                /**
                 * Terminal.app に渡す。
                 *
                 * この機械に入っている端末はこれだけ（実測：iTerm も Warp も
                 * Ghostty も無い）。**選ばせるものが一つしか無いなら、
                 * 聞くのは間違い。**
                 */
                let escaped = command.replacingOccurrences(of: "\"", with: "\\\"")
                let script = "tell application \"Terminal\"\nactivate\ndo script \"\(escaped)\"\nend tell"
                NSAppleScript(source: script)?.executeAndReturnError(nil)
            }
        }
        face.onTask = { id in
            guard let url = URL(string: "http://127.0.0.1:3002/?task=\(id)") else { return }
            openInIris(url)
        }
        face.snapshot = snapshot
        face.needsDisplay = true

        refreshSettings()

        if case let .ready(all) = snapshot, let first = all.pending.first {
            deciding = first
            face.deciding = first
            approve.isHidden = false
            refuse.isHidden = false
        } else {
            deciding = nil
            face.deciding = nil
            approve.isHidden = true
            refuse.isHidden = true
        }
    }

    @objc private func toggleListen() {
        onListen?()
        refreshSettings()
    }

    @objc private func toggleMotion() {
        onMotion?()
        refreshSettings()
    }

    /// The labels read back the state, so the switch says which way it is set.
    func refreshSettings() {
        listen.title = ambient() ? "常時待ち受け: 入" : "常時待ち受け: 切"
        listen.contentTintColor = ambient() ? Palette.accent : Palette.aside
        /**
         * Named for what it controls, not for the thing it controls.
         *
         * It read "コア: 動く", which says a core moves and not which core, or
         * what moving costs. What it actually decides is whether the mark spends
         * battery animating — so it says that.
         *
         * 「帯の」ではなくなった。帯は畳んだので、核はレールの頭にいる。
         * 存在しないものの設定に見えるのは、設定が効いていないのと同じくらい悪い。
         * 隣の「常時待ち受け」はマイクの設定で、帯とは無関係 — そのまま。
         */
        motion.title = stillCore() ? "核のアニメーション: 切" : "核のアニメーション: 入"
    }

    @objc private func allow() {
        guard let deciding else { return }
        onDecision?(deciding.sessionId, true)
        self.deciding = nil
        face.deciding = nil
        approve.isHidden = true
        refuse.isHidden = true
    }

    @objc private func deny() {
        guard let deciding else { return }
        onDecision?(deciding.sessionId, false)
        self.deciding = nil
        face.deciding = nil
        approve.isHidden = true
        refuse.isHidden = true
    }
}

/// Everything the square draws.
/**
 * 盤の面と外周。
 *
 * 巻物の後ろに敷いて、窓と同じ大きさで動かない。参考画像のとおり、
 * **外は純黒、面は `#06070A` 一色、境に細い線が一本** — 階調も、半透明も、
 * ぼかしも、光も置かない。
 */
final class BoardShell: NSView {

    override func draw(_ dirtyRect: NSRect) {
        // 塗りは窓が持っている。ここは外周の線だけ。**塗りを二箇所に置かない。**
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shell = NSBezierPath(roundedRect: inset, xRadius: 18, yRadius: 18)
        shell.lineWidth = 1 / (window?.backingScaleFactor ?? 2)
        Palette.Board.edge.setStroke()
        shell.stroke()
    }
}

final class Face: NSView {
    var snapshot: Snapshot = .unreachable("")
    /// The decision being asked for, drawn above the buttons.
    var deciding: PendingApproval?

    /**
     * 前回開いていたセッションと、今回いなくなったもの。
     *
     * 消えるだけでは、**終わったのか、こちらが見落としたのか分からない。**
     * 走っていたものが閉じたことは、一度は言われるべき知らせ。
     */

    /**
     * 課題の行の位置。描いたときに覚えて、押されたときに引く。
     *
     * 盤は一枚の絵なので、押せる場所は描いた側しか知らない。**描画と当たり
     * 判定を別々に計算すると、必ずずれる** — 高さを二度計算して盤が下まで
     * 巻けなくなったのと同じ形。
     */
    private var taskRows: [(rect: NSRect, id: String)] = []
    /// 進行状況の行。押すと出どころのセッションを開く。
    private var workRows: [(rect: NSRect, door: WorkRow.Door?, endedId: String?)] = []
    var onWork: ((WorkRow.Door) -> Void)?
    var onTask: ((String) -> Void)?

    override func mouseDown(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        trace("board press y=\(Int(local.y)) rows=\(workRows.count)")
        // まとめて消す。行の判定より先に見る —— 見出しの帯は行と重ならない。
        if let box = clearEndedRect, box.contains(local) {
            EndedLedger.shared.forgetAll()
            needsDisplay = true
            return
        }
        if let hit = workRows.first(where: { $0.rect.contains(local) }) {
            // 開けない行は押しても何もしない。**開いたふりはしない。**
            trace("board row door=\(hit.door == nil ? "なし" : "あり")")
            if let door = hit.door { onWork?(door) }
            /*
             * 控えから外すのは、**開けたかどうかに関わらず。**押したのなら
             * 見たということで、残しておく理由がその時点で無くなる。開く先が
             * 無い行を消せないままにすると、消しようのない行が積み上がる。
             */
            if let endedId = hit.endedId { forget(endedId: endedId); needsDisplay = true }
            return
        }
        guard let hit = taskRows.first(where: { $0.rect.contains(local) }) else { return }
        onTask?(hit.id)
    }

    /// 「終了 N件を消す」の押し場所。出していないときは `nil`。
    private var clearEndedRect: CGRect?

    /// 終わった作業の控え。実体は `EndedLedger.shared` — 盤の外にある。
    var ended: [EndedLedger.Ended] { EndedLedger.shared.rows }
    func forget(endedId: String) { EndedLedger.shared.forget(endedId) }

    /**
     * How far down the drawing actually went, reported after it went there.
     *
     * The height was computed a second time, in its own function, following the
     * same rules `draw` follows — and two copies of an arithmetic drift. They
     * did: the panel would not scroll to the bottom because the number it was
     * given was smaller than the content. Measuring the drawing itself cannot
     * disagree with the drawing.
     */
    var onHeight: ((CGFloat) -> Void)?
    private var reported: CGFloat = 0

    override var isFlipped: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let c = NSGraphicsContext.current?.cgContext else { return }

        // 面と外周は `BoardShell` が窓の側で描いている。ここは中身だけ。
        /**
         * 角の括弧と `I R I S` の行をやめた。
         *
         * どちらも「装置らしさ」のための飾りで、**中身を一つも言っていない。**
         * レールには飾りが一つも無く、利用者はあちらを気に入っている
         * — 地と、間隔と、意味を持つ色だけでできている。同じ機械の同じ画面
         * なので、こちらも同じ作りにする。区切りも罫線ではなく間隔にした。
         */
        let pad: CGFloat = 20
        // 窓の釦の下から始める。上に空を作らない。
        var y = bounds.maxY - 8
        // 描き直すたびに取り直す。前回の位置に当たり判定が残っていると、
        // 別の課題を開くことになる。
        taskRows = []
        workRows = []
        inked = 0

        guard case let .ready(all) = snapshot else {
            let why: String
            if case let .unreachable(w) = snapshot { why = w.isEmpty ? "接続できません" : w }
            else if case let .unreadable(w) = snapshot { why = w } else { why = "" }
            text(why, at: CGPoint(x: pad, y: y - 20), size: 14, colour: Palette.Board.subtle)
            used(y - 40)
            return
        }

        /**
         * 参考画像のとおり、二つの区画。予定と、進行状況。
         *
         * `docs/dashboard-reference-approved-2026-09-01.png` が唯一の基準。
         * カードにも、レーンにも、バッジにも読み替えない。
         */
        /*
         * ── 次の試験 ───────────────────────────────────
         *
         * 参考画像には無い。**利用者が「ダッシュボードに載せてくれれば
         * それでいい」と言ったから足した**もので、画像を読み替えたのでは
         * ない。区画の作り（見出しと罫）は下の二つと同じにする。
         *
         * ここに並ぶ他のものは、変わるから見る値打ちがある。試験だけは逆で、
         * **動かないから出す** — 日付が近づくこと自体が読みたいもので、
         * 遠いうちは見ないから、遠いうちに見えていないと気づく機会が無い。
         *
         * 読めなかった往復では区画ごと出さない。**「試験はありません」とは
         * 書かない** — 無いことと読めていないことは違い、この盤で書ける形は
         * 前者しか無いので、後者は黙る。
         */
        /*
         * ── 今日 ──────────────────────────────────────
         *
         * 分野ごとに一件と、いま残っている時間。
         *
         * `/api/focus` は 2026-08 から動いていて、**どの画面も読んでいな
         * かった**（2026-09-08、独立レビューを追いかけて分かった）。選ぶ
         * 規則は四百行あり、その一つ一つが元の失敗から来ている —— それが
         * 全部、誰も開かない口の向こうにあった。
         *
         * 盤に置くのは、ここが**いちばん見られている面**だから。予定と
         * 進行状況の上、試験の前。「今日どれに手を付けるか」は、何が
         * 止まっているかより先に読むもの。
         *
         * 読めなかった分野は**行を出さない。**「無い」と「読めていない」は
         * 別で、この盤に書ける形は前者しか無い（試験の区画と同じ規則）。
         */
        if let focus = all.focus, !focus.items.isEmpty {
            /*
             * 残り時間は見出しと同じ行の右端。
             *
             * 見出しを描いたあとの `y` は**罫の下**まで進んでいるので、
             * そこに右寄せで置くと罫の上に文字が乗る（実機で確認）。
             * 見出しの高さを先に取っておいて、同じ基線に合わせる。
             *
             * `reason` があるときは色を変える。`0` と `nil` を混ぜないのは
             * サーバ側と同じ理由で、**「もう無い」と「言えない」は次に
             * やることが違う。**
             */
            let headline = y
            y = boardHeading(c, "今日", y: y, pad: pad)
            if let room = focus.room, let line = room.summary, !line.isEmpty {
                let saying = room.reason == nil
                text(line, at: CGPoint(x: bounds.maxX - pad, y: headline - 12), size: 10,
                     colour: saying ? Palette.Board.subtle : Palette.Board.amber,
                     rightAt: bounds.maxX - pad)
            }

            /*
             * 試験が近いときは、そう言う。**選び方は変えない** ——
             * `EXAM_FOCUS_DAYS` の設計と同じで、変わるのは言い方だけ。
             */
            if focus.examMode == true, let days = focus.daysToExam {
                text("試験まで \(days)日", at: CGPoint(x: pad, y: y - 13), size: 11,
                     colour: Palette.Board.amber, weight: .semibold)
                y -= 20
            }

            let named: [String: String] = [
                "calendar": "予定", "exam": "試験", "study": "研究",
                "improvement": "改善", "os": "OS", "work": "仕事", "contest": "コンペ",
            ]
            /*
             * 予定と試験は、この区画では出さない。**盤の下に既に在る。**
             *
             * 「今日と明日の予定」は同じ予定を**時刻つきで**出すし、「次の試験」
             * は日数と出どころまで出す。ここに並べると、同じことを three
             * 通りの粗さで三度言うことになる —— レビューが「二重に持っている」
             * と呼んだ形そのもの。
             *
             * そして盤は高さの決まった窓で、**溢れた分は黙って切れる。**
             * 最初の版は六件並べたせいで「進行状況」が丸ごと画面の外へ出て、
             * 一番下の行が切られていた（実機で確認）。重なりではなく、
             * **窓から落ちていた。**
             *
             * ここが足すのは、盤のどこにも無かったもの —— 研究・改善・OS・
             * 仕事・コンペ。
             */
            let elsewhere: Set<String> = ["calendar", "exam"]
            var shown = 0
            for item in focus.items {
                if elsewhere.contains(item.area) { continue }
                // 読めていない分野は黙る。空欄を「無い」と読ませない。
                guard item.available != false, let title = item.title, !title.isEmpty else { continue }
                if shown >= 5 { break }
                shown += 1
                let base = y - 14
                /*
                 * 分野名は**短い方**を使う。
                 *
                 * `label` は表の管理区分そのままで、「医学部の試験」「未反映の
                 * 改善」のように長い。52ポイントの桁に収まらず、**題名の上に
                 * 重なって両方読めなくなっていた**（実機で確認）。
                 *
                 * ここで要るのは「どの分野か」だけで、区分の正式名ではない。
                 * 知らない分野が来たときだけ `label` に落ちる。念のため桁でも
                 * 切る —— 落ちた先が長い保証は無い。
                 */
                let label = named[item.area] ?? item.label ?? item.area
                text(fit(label, size: 10, weight: .regular, width: 46),
                     at: CGPoint(x: pad, y: base), size: 10, colour: Palette.Board.subtle)
                let room = bounds.maxX - pad - (pad + 52) - 62
                text(fit(title, size: 12, weight: .regular, width: room),
                     at: CGPoint(x: pad + 52, y: base), size: 12, colour: Palette.Board.text)
                if let due = item.due, !due.isEmpty {
                    // 日付だけ。時刻まで出すと、締切と待ち合わせが同じ顔になる。
                    let shortened = String(due.prefix(10)).replacingOccurrences(of: "-", with: "/")
                    text(String(shortened.dropFirst(5)),
                         at: CGPoint(x: bounds.maxX - pad, y: base), size: 10,
                         colour: Palette.Board.subtle, rightAt: bounds.maxX - pad)
                }
                y -= 21
            }
            /*
             * 読めなかった分野があれば、数だけ言う。**名前は出さない** ——
             * 分野名を並べても直しには繋がらず、行が増えるだけ。
             */
            if let out = focus.unavailable, !out.isEmpty {
                text("\(out.count)分野が読めていません", at: CGPoint(x: pad, y: y - 12),
                     size: 10, colour: Palette.Board.amber)
                y -= 18
            }
            y -= 8
            ink(y)
            y -= 12
        }

        if let exam = all.exam {
            y = boardHeading(c, "次の試験", y: y, pad: pad)
            let base = y - 15
            let days = exam.days <= 0 ? "今日" : "あと\(exam.days)日"
            // 日数を先に置く。桁が変わるのは右端なので、件名の幅をそこから引く。
            text(days, at: CGPoint(x: bounds.maxX - pad, y: base), size: 13,
                 colour: exam.days <= 3 ? Palette.Board.amber : Palette.accent,
                 rightAt: bounds.maxX - pad, weight: .semibold)
            let room = bounds.maxX - pad - (pad + 92) - 80
            text(fit(exam.title, size: 13, weight: .semibold, width: room),
                 at: CGPoint(x: pad, y: base), size: 13,
                 colour: Palette.Board.text, weight: .semibold)
            /*
             * 日付と、その先の件数と、出どころ。
             *
             * `from` が付いているのは、暦ではなく**印刷された講義日程表**から
             * 答えたということ。日程表には版があり、刷ったあとに動く。
             * **出どころの違いは、日付と同じ大きさの事実。**
             */
            var note = String(exam.date.dropFirst(5)).replacingOccurrences(of: "-", with: "/")
            if exam.after > 0 { note += " ・ この先あと\(exam.after)件" }
            if let from = exam.from { note += " ・ \(from)" }
            text(note, at: CGPoint(x: pad, y: base - 17), size: 11, colour: Palette.Board.subtle)
            y -= 44
            ink(y)
            y -= 12
        }

        // ── 今日と明日の予定 ─────────────────────────────
        do {
            y = boardHeading(c, "今日と明日の予定", y: y, pad: pad)
            let calendar = Foundation.Calendar.current
            let clock = DateFormatter()
            clock.dateFormat = "HH:mm"
            var dated: [(Date, CalendarEvent)] = []
            for event in all.events {
                guard !event.allDay, let when = eventDate(event.start) else { continue }
                guard when >= Date() else { continue }
                guard calendar.isDateInToday(when) || calendar.isDateInTomorrow(when) else { continue }
                dated.append((when, event))
            }
            let soon = dated.sorted { $0.0 < $1.0 }

            if soon.isEmpty {
                text("この先の予定はありません", at: CGPoint(x: pad, y: y - 15),
                     size: 12, colour: Palette.Board.subtle)
                y -= 28
            }
            for (date, event) in soon.prefix(4) {
                /**
                 * 三つとも同じ行に置く。
                 *
                 * 曜日と件名が `y - 17`、時刻だけ `y - 14` に描かれていて、
                 * **三ポイントずれていた。**大きさを変えたときに片方だけ直り
                 * 損ねたもの。件名の幅も 14 で測って 12 で描いていた。
                 * **一行の値は一箇所で持つ。**
                 */
                let base = y - 15
                let size: CGFloat = 12
                let today = calendar.isDateInToday(date)
                let titleLeft = pad + 92
                text(today ? "今日" : "明日", at: CGPoint(x: pad, y: base), size: size,
                     colour: today ? Palette.accent : Palette.Board.text, weight: .semibold)
                text(clock.string(from: date), at: CGPoint(x: pad + 34, y: base),
                     size: size, colour: Palette.Board.text, weight: .semibold)
                text(fit(event.title, size: size, weight: .semibold,
                         width: bounds.maxX - pad - titleLeft - 64),
                     at: CGPoint(x: titleLeft, y: base), size: size,
                     colour: Palette.Board.text, weight: .semibold)
                /**
                 * 移動時間は、測れているものだけ。
                 *
                 * 次の予定にしか出ない — **測っていないものに「移動◯分」とは
                 * 書けない。**
                 */
                /*
                 * 日程表と時刻が違うなら、**その行に添える。**
                 *
                 * 「明日は8:30から授業あると思うんだけど」（利用者、
                 * 2026-09-08）。日程表は 1限＝08:30、カレンダーは 09:40 で、
                 * **気づいたのは本人の記憶だった。**IRIS は両方を持っていた。
                 *
                 * 別の欄に「食い違い 2件」と出すこともできるが、**違いが
                 * 意味を持つのは時刻の隣**で、そこから離すと読む順が一つ増える。
                 * どちらが正しいとは書かない —— 紙には版があり、刷ったあとに
                 * 動く。**違うと言うだけ。**
                 */
                let ymd = DateFormatter()
                ymd.dateFormat = "yyyy-MM-dd"
                let key = ymd.string(from: date)
                let folded = event.title.replacingOccurrences(of: " ", with: "")
                    .replacingOccurrences(of: "　", with: "")
                if all.lectures?.compared == true,
                   let gap = all.lectures?.moved.first(where: {
                       let mine = $0.title.replacingOccurrences(of: " ", with: "")
                           .replacingOccurrences(of: "　", with: "")
                       return $0.date == key && (mine.contains(folded) || folded.contains(mine))
                   }),
                   let says = gap.scheduled {
                    text("日程表 \(says)", at: CGPoint(x: bounds.maxX - pad, y: base),
                         size: 11, colour: Palette.Board.amber, rightAt: bounds.maxX - pad)
                } else if all.lectures?.compared == true,
                          let extra = (all.lectures?.surplus ?? []).first(where: {
                              let mine = $0.title.replacingOccurrences(of: " ", with: "")
                                  .replacingOccurrences(of: "　", with: "")
                              return $0.date == key && (mine.contains(folded) || folded.contains(mine))
                          }) {
                    /*
                     * 日程表のその日に無い授業。**別の日の複製**であることが多い
                     * （2026-09-16 の演習は 9/18 のものだった）。どちらが正しいとは
                     * 書かない —— 無い、とだけ。
                     *
                     * 試験だけは色を変える。日を間違えた試験は、間違えた日まで
                     * 気づかない（実測 2026-09-28、暦の 10/20 病理学Ⅱ各論試験は
                     * 紙では 10/26）。
                     */
                    let exam = extra.kind == "exam"
                    text(exam ? "日程表に無い試験" : "日程表に無い", at: CGPoint(x: bounds.maxX - pad, y: base),
                         size: 11, colour: exam ? Palette.danger : Palette.Board.amber,
                         rightAt: bounds.maxX - pad)
                } else if all.lectures?.compared == true,
                          let moved = (all.lectures?.shifted ?? []).first(where: {
                              let mine = $0.title.replacingOccurrences(of: " ", with: "")
                                  .replacingOccurrences(of: "　", with: "")
                              return $0.calendar == key && (mine.contains(folded) || folded.contains(mine))
                          }) {
                    // 暦はこの日に持っているが、紙は別の日に置いている。
                    text("日程表 \(moved.date.suffix(5))", at: CGPoint(x: bounds.maxX - pad, y: base),
                         size: 11, colour: moved.kind == "exam" ? Palette.danger : Palette.Board.amber,
                         rightAt: bounds.maxX - pad)
                } else if calendar.isDateInToday(date), let road = all.road, let minutes = road.minutes,
                   date == soon.first?.0 {
                    text("移動\(minutes)分", at: CGPoint(x: bounds.maxX - pad, y: base),
                         size: 11, colour: Palette.Board.subtle, rightAt: bounds.maxX - pad)
                }
                y -= 26
                ink(y)
            }
            y -= 12
        }

        // ── 進行状況 ─────────────────────────────────────
        do {
            let progressHead = y
            y = boardHeading(c, "進行状況", y: y, pad: pad)
            /*
             * 終わった行がいくつか在るときだけ、まとめて外す口を出す。
             *
             * **無いときに出すと、押せるのに何も起きない物になる。**位置は
             * 見出しと同じ基線の右端 —— 他の区画の数字と同じところ。
             */
            let endedCount = ended.count
            if endedCount > 0 {
                let label = "終了 \(endedCount)件を消す"
                text(label, at: CGPoint(x: bounds.maxX - pad, y: progressHead - 12), size: 10,
                     colour: Palette.accent, rightAt: bounds.maxX - pad)
                clearEndedRect = CGRect(
                    x: bounds.maxX - pad - 110, y: progressHead - 18, width: 110, height: 18
                )
            } else {
                clearEndedRect = nil
            }
            let work = workRows(all)
            // 何件の材料から何行できたか。空のときに推測で語らないため。
            trace("board work rows=\(work.count) sessions=\(all.sessions.count) dev=\(all.dev?.count ?? -1)")
            if work.isEmpty {
                text("動いているものはありません", at: CGPoint(x: pad, y: y - 18),
                     size: 14, colour: Palette.Board.subtle)
                y -= 34
            }
            for row in work.prefix(10) {
                y = workRow(c, y: y, row: row, pad: pad)
                ink(y)
            }
            // 一覧の終わりと次の見出しのあいだ。区切りは間隔が持つ。
            y -= 26
        }

        /**
         * FDP の課題。**手が要るものだけを、要る順に。**
         *
         * 台帳をそのまま写すと十行になり、利用者いわく「パッと読んで
         * 分からない」。読む人が知りたいのは全部ではなく、**いま詰まって
         * いるのはどれか**。だから並べ替えは判定が先、期限が後で、完了は
         * 出さない（件数だけ）。
         *
         * 判定はシートの `自動判定` 列そのままで、こちらでは計算しない。
         * 二箇所で計算すれば必ずずれる。
         */
        if let fdp = all.fdp {
            if fdp.ok, let tasks = fdp.tasks {
                /**
                 * 並べ替えはサーバがやっている。ここではしない。
                 *
                 * 同じ規則を web と盤の両方に置いていたが、**二箇所で
                 * 並べ替えれば「どれが急ぎか」の答えが割れうる。**この
                 * 一日で何度も直したのと同じ形なので、`/api/fdp/tasks` が
                 * 並べた順をそのまま出す。完了だけはここで落とす — 出す
                 * 件数は面ごとに違っていい。
                 */
                let live = tasks.filter { $0.verdict != "完了" && $0.status != "完了" }
                let stopped = live.filter { $0.verdict == "更新停止" }.count
                let late = live.filter { $0.verdict == "遅延" }.count
                /**
                 * 見出しは**数だけ**が色を持つ。
                 *
                 * 「7日超 2」を丸ごと橙にしていた。橙は「いま見るべきもの」に
                 * だけ使うと決めたので、**見出しの語まで橙にすると、その約束が
                 * 一行ごとに薄まる。**語は添え字の色、数だけ橙。
                 */
                let limit = fdp.settings?.stalledAfterDays ?? 7
                let count = late > 0 ? late : stopped
                let title = late > 0
                    ? "課題（FDP）  期限超過"
                    : (stopped > 0 ? "課題（FDP）  \(limit)日超" : "課題（FDP）")
                y = section(
                    c, title,
                    count: "\(count > 0 ? count : live.count)",
                    countColour: count > 0 ? Palette.attention : Palette.aside,
                    y: y, pad: pad
                )
                for task in live.prefix(5) {
                    taskRow(c, y: y - 34, height: 34, task: task, pad: pad)
                    ink(y - 34)
                    taskRows.append((
                        rect: NSRect(x: pad, y: y - 34, width: bounds.width - pad * 2, height: 34),
                        id: task.id
                    ))
                    y -= 34
                }
                if live.count > 5 {
                    text(
                        "ほか \(live.count - 5)",
                        at: CGPoint(x: pad, y: y - 14), size: 10, colour: Palette.aside
                    )
                    y -= 20
                }
                if let done = fdp.doneCount, done > 0 {
                    text(
                        "完了 \(done)",
                        at: CGPoint(x: pad, y: y - 14), size: 10, colour: Palette.aside
                    )
                    y -= 20
                }
            } else {
                // **0件ではない。**読めなかったことは、読めなかったと書く。
                y = section(c, "課題（FDP）", y: y, pad: pad)
                text(
                    fdp.error ?? "課題台帳を読めませんでした。",
                    at: CGPoint(x: pad, y: y - 14), size: 11, colour: Palette.attention
                )
                y -= 22
            }
            y -= 22
        }

        /**
         * The project instrument is gone.
         *
         * It drew concentric rings around one number — 14/18, 77% — which is
         * the same figure taken off the band for being a sum over unrelated
         * projects that moves for reasons belonging to neither and cannot be
         * acted on. Removing it from the band and then drawing it here,
         * larger and more finely graduated, is the same claim made twice with
         * better typography.
         *
         * What replaced it is directly below: the tasks themselves, blocked
         * first, with the reason each one is stuck. That list answers the
         * question the dial was decorating.
         *
         * `instrument`, `dial` and `depth` are still in this file. They were
         * three attempts' worth of work and the next thing that wants a ring
         * should start from them rather than from nothing.
         */
        // 区切りは罫ではなく間隔。線が一本だけ残っていた。
        y -= 10

        /**
         * 「IRIS 開発タスク」の欄は外した。
         *
         * 中身は上の「進行状況」に入っている。**IRIS のことが盤の二箇所に
         * あった**うえ、この欄が並べていたのは Recall と NeuroAtlas の仕事
         * で、見出しの言葉とも合っていなかった。
         *
         * 止まっている理由（台帳の `notes`）はここに出していたが、内部の
         * 課題番号を含む生の文で、読み手には解けない。**理由は IRIS を
         * 開けば読める** — 行を押せばそこへ行く。
         */
        /**
         * 監査の行は消した。
         *
         * 「openai で監査できます」と毎日同じことを言っていた。**毎日同じ
         * ことを言う行は読まれなくなる。**弱くなったときだけ出す形にも
         * したが、利用者の判断で外した — この盤は「いま何が起きているか」
         * を見る場所で、能力の宣言はそこに要らない。
         *
         * `/api/review/capability` は残っている。必要になったら別の場所で。
         */
        if let budget = all.budget,
           let day = budget.windows.first(where: { $0.window == "day" }),
           let limit = day.limitUsd, limit > 0 {
            let spent = day.spentUsd ?? 0
            /**
             * 棒をやめた。**盤に残っていた最後の棒。**
             *
             * 上の一覧はどれも「語と数」で読ませているのに、ここだけが図形
             * だった。しかも $0.11 / $5 の棒は、**幅の 2% を塗った線**にしか
             * ならず、形として何も言っていない。
             *
             * 上限に近づいたときだけ色を持つ。それ以外は添え字の色 — 支出は
             * 毎日見るものではなく、**近づいたときだけ見るもの**なので。
             */
            let share = spent / limit
            /**
             * 何の支出かを言う。
             *
             * 「本日の支出」では**何にいくら払ったのか分からない。**これは
             * IRIS 自身が呼んだ従量課金の API 料金で、レールに出ている
             * Claude や Codex の割合（定額の契約）とは別のもの。**同じ画面に
             * 二種類のお金の話がある**ので、名前で分ける。
             */
            text("IRIS の API 料金（今日）", at: CGPoint(x: pad, y: y - 12), size: 10,
                 colour: Palette.Board.subtle)
            text(
                String(format: "$%.2f / $%.0f", spent, limit),
                at: CGPoint(x: 0, y: y - 12), size: 11,
                colour: share >= 0.85 ? Palette.danger
                    : (share >= 0.6 ? Palette.attention : Palette.Board.subtle),
                rightAt: bounds.maxX - pad
            )
            y -= 26
        }

        /**
         * 「全体」のゲージと、数字の三つ組をやめた。
         *
         * 全体は無関係なプロジェクトの合計で、**どちらの理由でも動かせない**
         * — 帯から外したのと同じ理由で、ここに大きく描き直すのは同じ主張を
         * 二度することだった。
         *
         * 承認待ち・提案・実行中の三つ組は、**すぐ上の一文が同じことを
         * 言っている。**承認待ちがあるときは、下の判断欄が本文ごと出す。
         *
         * 支出だけ残す。**上限が設定されているときだけ**出る、比べる相手の
         * ある数字なので。
         */
        if all.approvals > 0 { depth(c, y: y - 4, height: 8, warm: true) }

        /**
         * What is being agreed to, above the buttons that agree to it.
         *
         * Without this the panel would offer a decision and not say what the
         * decision is, which is the thing that makes an easy approval
         * dangerous. With it, the sentence and the button are one object.
         */
        if let deciding {
            rule(c, y: y, from: pad, to: bounds.maxX - pad)
            y -= 20
            text(
                deciding.toolName, at: CGPoint(x: pad, y: y - 10),
                size: 10, colour: Palette.pending, mono: true
            )
            y -= 18
            let sentence = deciding.summary ?? "内容を読むには IRIS を開いてください。"
            for line in wrap(sentence, width: Int((bounds.width - pad * 2) / 7.4)).prefix(3) {
                text(line, at: CGPoint(x: pad, y: y - 12), size: 12, colour: Palette.headline)
                y -= 17
            }
        }
        used(min(y, inked == 0 ? y : inked - 8))
    }

    /**
     * How tall the content is, so the scroll view knows what it is scrolling.
     *
     * Computed from the same rules `draw` follows rather than measured after
     * the fact. The two could drift, and the cost of them drifting is content
     * drawn where nobody can reach it — which is the failure this exists to
     * fix, so the arithmetic is kept next to the drawing that uses it.
     */
    /// Called at the end of `draw` with the lowest point reached.
    /**
     * 最後に**何かを描いた**高さ。
     *
     * `y` は空の区画でも余白のぶん下がるので、**中身が終わったあとも
     * 減り続ける。**その `y` で高さを報告していたので、**下に何も無い帯が
     * できていた**（「下の何割かが死んでる」の正体のもう半分）。
     * 描いたときだけ記録して、そこまでを高さにする。
     */
    private var inked: CGFloat = 0
    private func ink(_ y: CGFloat) { inked = min(inked == 0 ? y : inked, y) }

    private func used(_ bottom: CGFloat) {
        let height = bounds.maxY - bottom + 20
        guard abs(height - reported) > 1 else { return }
        reported = height
        // Next runloop: changing a constraint inside `draw` re-enters layout.
        DispatchQueue.main.async { [weak self] in self?.onHeight?(height) }
    }

    /// Broken on width, counting characters — Japanese has no spaces to break at.
    private func wrap(_ text: String, width: Int) -> [String] {
        guard width > 4 else { return [text] }
        var lines: [String] = []
        var line = ""
        for character in text {
            line.append(character)
            if line.count >= width {
                lines.append(line)
                line = ""
            }
        }
        if !line.isEmpty { lines.append(line) }
        return lines
    }

    /**
     * One project, as a ring.
     *
     * Drawn in the same four parts the bar was, and for the same reason:
     * blocked work is not partial progress. An arc that filled to a single
     * percentage would say the project is further along than it is.
     */
    /**
     * Concentric rings, one per project, around a shared centre.
     *
     * Read from the outside in, largest project first, so the ring that has
     * most riding on it is the one nearest the graduated scale. Each is drawn
     * in the same four parts as before — blocked work is still not partial
     * progress — with a gap between segments so a ring reads as an instrument
     * rather than as a filled band.
     */
    private func instrument(
        _ c: CGContext, centre: CGPoint, outer: CGFloat, projects: [LedgerProject]
    ) {
        let done = projects.reduce(0) { $0 + $1.progress.done }
        let total = projects.reduce(0) { $0 + $1.progress.total }
        let overall = total > 0 ? CGFloat(done) / CGFloat(total) : 0

        // The scale. Fine graduations all the way round, brighter as far as the
        // whole portfolio has got — the number in the middle, said as a shape.
        c.setLineWidth(1)
        for i in 0..<72 {
            let t = CGFloat(i) / 72
            let angle = .pi / 2 - t * .pi * 2
            let long = i % 6 == 0
            let inner = outer * (long ? 1.00 : 1.045)
            let edge = outer * 1.10
            c.setStrokeColor(
                (t <= overall ? Palette.accent : NSColor.white)
                    .withAlphaComponent(t <= overall ? 0.55 : 0.09).cgColor
            )
            c.move(to: CGPoint(x: centre.x + cos(angle) * inner, y: centre.y + sin(angle) * inner))
            c.addLine(to: CGPoint(x: centre.x + cos(angle) * edge, y: centre.y + sin(angle) * edge))
            c.strokePath()
        }

        // Two hairlines bounding the scale. Instruments are bounded twice.
        for r in [outer * 1.13, outer * 0.94] {
            c.setLineWidth(0.6)
            c.setStrokeColor(Palette.line.withAlphaComponent(0.45).cgColor)
            c.addArc(center: centre, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: false)
            c.strokePath()
        }

        let ordered = projects.sorted { $0.progress.total > $1.progress.total }
        let band = outer * 0.62 / CGFloat(max(1, ordered.count))
        let width = max(3, band * 0.52)

        for (i, project) in ordered.enumerated() {
            let radius = outer * 0.86 - band * CGFloat(i)
            c.setLineWidth(width)
            c.setLineCap(.butt)
            c.setStrokeColor(NSColor(calibratedWhite: 1, alpha: 0.055).cgColor)
            c.addArc(center: centre, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
            c.strokePath()

            let p = project.progress
            guard p.total > 0 else { continue }
            var from: CGFloat = .pi / 2
            let gap: CGFloat = 0.04
            for (count, colour) in [
                (p.done, Palette.done), (p.inProgress, Palette.accent),
                (p.blocked, Palette.attention), (p.unknown, Palette.danger),
            ] where count > 0 {
                let sweep = .pi * 2 * CGFloat(count) / CGFloat(p.total)
                c.setStrokeColor(colour.withAlphaComponent(0.95).cgColor)
                c.addArc(
                    center: centre, radius: radius,
                    startAngle: from - gap / 2, endAngle: from - sweep + gap / 2, clockwise: true
                )
                c.strokePath()
                from -= sweep
            }

        }

        /**
         * The names underneath, not on leader lines out to the edge.
         *
         * Lines to the left was the first idea and it collapses: rings sit a
         * few points apart, so two labels land at nearly the same height and
         * overwrite each other — which is exactly what happened, with
         * "NeuroAtlas 1/3" printed through "Recall 12/15". A legend below has
         * one row per project and cannot collide with anything.
         */
        var legendY = centre.y - outer * 1.16 - 12
        for (i, project) in ordered.enumerated() {
            let radius = outer * 0.86 - band * CGFloat(i)
            // A stub of the ring itself, so the row and the arc are paired by
            // the same thing that distinguishes them: their distance from the
            // centre.
            c.setLineWidth(3)
            c.setStrokeColor(Palette.accent.withAlphaComponent(0.75).cgColor)
            c.move(to: CGPoint(x: 20, y: legendY + 4))
            c.addLine(to: CGPoint(x: 20 + max(6, radius / outer * 16), y: legendY + 4))
            c.strokePath()

            let p = project.progress
            text(
                clip(project.name, 16), at: CGPoint(x: 44, y: legendY), size: 11, colour: Palette.headline
            )
            text(
                "\(p.done)/\(p.total)", at: CGPoint(x: bounds.maxX - 20, y: legendY),
                size: 11, colour: Palette.aside, mono: true, rightAt: bounds.maxX - 20
            )
            legendY -= 17
        }

        // The centre: everything, as one figure.
        text(
            "\(Int(overall * 100))%", at: CGPoint(x: centre.x, y: centre.y - 2),
            size: 22, colour: Palette.headline, mono: true, centre: centre.x
        )
        text(
            "\(done)/\(total) 完了", at: CGPoint(x: centre.x, y: centre.y - 16),
            size: 9, colour: Palette.aside, mono: true, centre: centre.x
        )
    }


    /// "残り 2日04時間", or why there is no figure to count down to.
    private func remaining(until date: Date?, known: Bool) -> String {
        guard known else { return "未取得" }
        guard let date else { return "リセット時刻なし" }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return "まもなくリセット" }
        let days = Int(seconds) / 86400
        let hours = (Int(seconds) % 86400) / 3600
        return days > 0 ? "残り \(days)日\(String(format: "%02d", hours))時間" : "残り \(hours)時間"
    }

    private func dial(_ c: CGContext, centre: CGPoint, radius: CGFloat, progress: Progress) {
        /**
         * A dial rather than a doughnut.
         *
         * The first one was a thick ring in four colours, which reads as a pie
         * chart in a business deck. What separates an instrument from a chart
         * is not the data — it is that an instrument is built out of a graduated
         * scale, a thin needle-weight indicator, and a lot of empty space. So:
         * ticks around the outside, a hairline containing circle, and the
         * segments drawn narrow with gaps between them.
         *
         * Every part still comes from `Progress`. The ticks are twelve because
         * a scale needs graduations, not because twelve means anything.
         */
        let ring = radius * 0.86

        // Graduations. Brighter where the arc has reached, so the scale itself
        // carries the reading and the eye can take it without the number.
        let filled = progress.total > 0 ? CGFloat(progress.done) / CGFloat(progress.total) : 0
        c.setLineWidth(1)
        for i in 0..<36 {
            let t = CGFloat(i) / 36
            let angle = .pi / 2 - t * .pi * 2
            let long = i % 3 == 0
            let inner = radius * (long ? 1.10 : 1.14)
            let outer = radius * 1.20
            c.setStrokeColor(
                (t <= filled ? Palette.accent : NSColor.white)
                    .withAlphaComponent(t <= filled ? 0.5 : 0.10).cgColor
            )
            c.move(to: CGPoint(x: centre.x + cos(angle) * inner, y: centre.y + sin(angle) * inner))
            c.addLine(to: CGPoint(x: centre.x + cos(angle) * outer, y: centre.y + sin(angle) * outer))
            c.strokePath()
        }

        // The track, thin.
        c.setLineWidth(max(2.5, radius * 0.10))
        c.setLineCap(.butt)
        c.setStrokeColor(NSColor(calibratedWhite: 1, alpha: 0.06).cgColor)
        c.addArc(center: centre, radius: ring, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        c.strokePath()

        guard progress.total > 0 else { return }

        // Segments, with a gap between them, from straight up and clockwise.
        var from: CGFloat = .pi / 2
        let gap: CGFloat = 0.035
        let parts: [(Int, NSColor)] = [
            (progress.done, Palette.done),
            (progress.inProgress, Palette.accent),
            (progress.blocked, Palette.attention),
            (progress.unknown, Palette.danger),
        ]
        for (count, colour) in parts where count > 0 {
            let sweep = .pi * 2 * CGFloat(count) / CGFloat(progress.total)
            c.setStrokeColor(colour.withAlphaComponent(0.95).cgColor)
            c.setLineCap(.butt)
            c.addArc(
                center: centre, radius: ring,
                startAngle: from - gap / 2, endAngle: from - sweep + gap / 2, clockwise: true
            )
            c.strokePath()
            from -= sweep
        }

        // A hairline inside the track. Instruments are bounded twice.
        c.setLineWidth(0.6)
        c.setStrokeColor(Palette.line.withAlphaComponent(0.5).cgColor)
        c.addArc(center: centre, radius: radius * 0.62, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        c.strokePath()

        /**
         * The figure, and what it counts.
         *
         * "80 %" in a circle says nothing about what reached eighty percent.
         * It is tasks: how many of this project's are done. Two lines of five
         * characters is cheap, and without them the dial is a number that has
         * to be asked about — which it was.
         */
        let percent = Int(Double(progress.done) / Double(progress.total) * 100)
        text("\(percent)%", at: CGPoint(x: centre.x, y: centre.y + 1), size: 19,
             colour: Palette.headline, mono: true, centre: centre.x)
        text("\(progress.done)/\(progress.total) 完了", at: CGPoint(x: centre.x, y: centre.y - 14),
             size: 9, colour: Palette.aside, mono: true, centre: centre.x)
    }

    private func gauge(_ c: CGContext, y: CGFloat, label: String, value: Double, readout: String, pad: CGFloat) {
        text(label, at: CGPoint(x: pad, y: y - 12), size: 11, colour: Palette.aside)
        let barX = pad + 46
        let barWidth = bounds.width - pad * 2 - 46 - 96
        let track = CGRect(x: barX, y: y - 11, width: barWidth, height: 5)
        c.setFillColor(NSColor(calibratedWhite: 1, alpha: 0.07).cgColor)
        c.fill(track)
        let filled = CGFloat(min(1, max(0, value)))
        c.setFillColor((value >= 0.8 ? Palette.attention : Palette.accent).withAlphaComponent(0.8).cgColor)
        c.fill(CGRect(x: barX, y: y - 11, width: barWidth * filled, height: 5))
        text(readout, at: CGPoint(x: bounds.maxX - pad, y: y - 12), size: 10,
             colour: Palette.aside, mono: true, rightAt: bounds.maxX - pad)
    }

    /**
     * A rule, doubled.
     *
     * One hairline is a separator. Two, unevenly weighted and a little apart,
     * are how a panel is bounded in this visual language — the second line is
     * what stops it reading as a web page divider.
     */
    /**
     * A faint light behind a band that has something in it.
     *
     * The distinction is the whole point, and it is what separates this from
     * the texture a film HUD lays over everything: it appears where something
     * needs attention and nowhere else, so its presence carries the meaning
     * rather than merely marking where content sits.
     *
     * Fixed alpha — the amount of light never encodes a value, because a glow
     * that brightens with a number is a second, unlabelled read of it. And the
     * caller decides whether to draw at all; a version that always drew and only
     * changed colour said nothing, which is what this used to do.
     */
    private func depth(_ c: CGContext, y: CGFloat, height: CGFloat, warm: Bool) {
        let tint = warm ? Palette.attention : Palette.accent
        guard let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [
                tint.withAlphaComponent(0.055).cgColor,
                tint.withAlphaComponent(0).cgColor,
            ] as CFArray,
            locations: [0, 1]
        ) else { return }
        c.saveGState()
        c.addRect(CGRect(x: 0, y: y, width: bounds.width, height: height))
        c.clip()
        c.drawRadialGradient(
            gradient,
            startCenter: CGPoint(x: bounds.midX, y: y + height / 2), startRadius: 0,
            endCenter: CGPoint(x: bounds.midX, y: y + height / 2),
            endRadius: max(bounds.width, height) * 0.62,
            options: []
        )
        c.restoreGState()
    }

    /**
     * A short mark beside something that wants attention, and nothing beside
     * anything that does not.
     *
     * Drawn from `Progress.blocked`, `Progress.unknown` and the approval count
     * — never as ornament. A rule that appears on every row is a border; one
     * that appears on some rows is information.
     */
    private func flag(_ c: CGContext, y: CGFloat, height: CGFloat, colour: NSColor) {
        c.setFillColor(colour.withAlphaComponent(0.8).cgColor)
        c.fill(CGRect(x: 10, y: y, width: 2, height: height))
    }

    /**
     * One session: a clock, a place, and how long it has been quiet.
     *
     * The arc is the glyph. Sixty minutes is a full turn, so the shape carries
     * the number without the number having to be read — and because it is
     * clamped, an hour and a day look the same, which is correct: past a point
     * the only fact that matters is that it stopped.
     */
    /**
     * 課題一行。番号・件名・判定・期限。
     *
     * 判定は**印と色**で先に読ませる。橙が「手が要る」で、灰が「順調」。
     * 文字だけだと、五行のうちどれが止まっているのかを読んで探すことになる。
     */
    /**
     * 課題一行 — 実際には二段。
     *
     * 一段に番号・件名・判定・期限を横に並べたら、**幅が足りず件名が切れた。**
     * 上段を件名、下段を状態にすれば、どちらも切れずに入る。
     *
     * **台帳の語をそのまま出さない。**`更新停止` はシートの列の値であって、
     * 状態の説明ではない — 利用者いわく「どういう状態か分からない」。
     * 日数で言えば閾値の説明が要らないし、評価（順調）ではなく事実
     * （何日前に動いたか）になる。規則は iris-70 が `設定` タブから確認した
     * もので、**更新停止は「最終更新から7日以上」**。
     */
    private func taskRow(_ c: CGContext, y: CGFloat, height: CGFloat, task: FdpTask, pad: CGFloat) {
        /**
         * 保留は無彩色。警告でも成功でもない。
         *
         * 状態の三色（緑・橙・赤）は意味に予約してある
         * （`docs/dark-ui-colour.md`）。**意図して止めているものは、どの意味
         * でもない** — 新しい色を足すのではなく、色を付けないのが答え。
         */
        let colour: NSColor
        switch task.verdict {
        case "遅延": colour = Palette.danger
        case "更新停止": colour = Palette.attention
        case "順調": colour = Palette.done
        default: colour = Palette.aside
        }
        /**
         * 丸ではなく記号。
         *
         * 塗った丸は「オンライン」「稼働中」の語彙で、**課題は稼働して
         * いない。**そして色だけで状態を運ばないという規則にも、記号の方が
         * 素直に合う。
         */
        /**
         * 記号は形が違いを運ぶ。**色は例外にだけ。**
         *
         * `○` を緑にしていた。5行のうち3行が緑なら、**緑はこのグループの中で
         * 何も区別していない** — 既定を色で塗ると、例外の色が効かなくなる。
         * 形（`○ △ !`）は色を外しても残る。
         */
        let glyph: String
        let glyphColour: NSColor
        switch task.verdict {
        /**
         * 記号にも色を付けない。
         *
         * `△` を橙にしていたが、**形がもう違いを運んでいる。**同じ違いを色でも
         * 言うと、一行に橙が二つ（記号と `未更新`）並び、**橙の数が事実の数の
         * 二倍になる。**色覚に依存しないための冗長は、形の側で足りている。
         */
        case "遅延": glyph = "!"; glyphColour = Palette.aside
        case "更新停止": glyph = "△"; glyphColour = Palette.aside
        case "保留": glyph = "—"; glyphColour = Palette.aside
        default: glyph = "○"; glyphColour = Palette.aside
        }
        text(glyph, at: CGPoint(x: pad, y: y + height - 17), size: 10, colour: glyphColour)

        /**
         * 件名が先、番号は下段の端。
         *
         * `T006 AIエンジニアリング…` の順だと、**最初に目に入るのが台帳の
         * 通し番号**になり、行が「データベースの行」に見える。番号は探すとき
         * に要るもので、読むときに要るものではない。
         */
        let left = pad + 14
        text(
            clip(task.title, max(6, Int((bounds.maxX - pad - left) / 12))),
            at: CGPoint(x: left, y: y + height - 17), size: 12, colour: Palette.headline
        )
        text(
            task.id, at: CGPoint(x: bounds.maxX - pad, y: y + 3),
            size: 10, colour: Palette.aside, rightAt: bounds.maxX - pad
        )

        /**
         * 下段：いまどうなっているか、そして期限。
         *
         * **台帳の語は一つも出さない。**`更新停止` の正体は「最終更新から
         * N日」で、その N を書けば閾値の説明が要らない。`順調` は評価なので
         * 事実（何日前に動いたか）に置き換える。まだ始まっていないものは
         * 止まっているのではない — そこを混ぜていたのが、T008〜T010 が
         * 全部「順調」に見えていた理由。
         */
        /**
         * **行を丸ごと色で塗らない。注意すべき語だけ。**
         *
         * 「29日 未更新 ・ 期限まで76日」を全部橙で出していたので、
         * **一行のうち警告なのは二文字なのに、行全体が警告に見えた。**
         * 数字は本文の色、期限は添え字の色、`未更新` だけが橙。
         */
        /**
         * 語ごとに色を決める。**節ごとではなく。**
         *
         * 「29日 未更新」を丸ごと橙にしていた。**警告なのは `未更新` の三文字
         * で、`29日` は事実の数**。節ごとに塗ると、一行のうち色が付くべき
         * 部分が三倍になる。`docs/dark-ui-colour.md` にはそう書いてあって、
         * 実装だけが違っていた。
         */
        var parts: [[(String, Bool)]] = []
        if task.verdict == "保留" {
            /**
             * 保留は「何日動いていない」を出さない。
             *
             * 動いていないのは**そう決めたから**で、日数はもう読みではない。
             */
            var hold: [(String, Bool)] = [("\(clock(task.heldUntil))まで", false), ("保留", true)]
            if let why = task.holdReason, !why.isEmpty { hold.append(("— \(why)", false)) }
            parts.append(hold)
        } else if let days = task.startsInDays, days > 0 {
            parts.append([("\(task.start ?? "") 開始予定", false)])
        } else if let still = task.stillDays {
            parts.append(
                still == 0 ? [("今日 更新", false)] : [("\(still)日", false), ("未更新", true)]
            )
        }
        if let days = task.dueInDays {
            parts.append(
                days < 0
                    ? [("期限を", false), ("\(-days)日 過ぎています", true)]
                    : [("期限まで \(days)日", false)]
            )
        }

        var x = left
        let font = NSFont.systemFont(ofSize: 10)
        func put(_ run: String, _ coloured: Bool) {
            text(run, at: CGPoint(x: x, y: y + 2), size: 10,
                 colour: coloured ? colour : Palette.aside)
            x += NSAttributedString(string: run, attributes: [.font: font]).size().width
        }
        for (i, part) in parts.enumerated() {
            if i > 0 { put(" ・ ", false) }
            for (j, run) in part.enumerated() {
                if j > 0 { put(" ", false) }
                put(run.0, run.1)
            }
        }
    }

    /// `2026-10-20` を `10月20日` に。読めなければそのまま出す。
    private func clock(_ day: String?) -> String {
        guard let day else { return "" }
        let parts = day.split(whereSeparator: { $0 == "-" || $0 == "/" })
        guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) else { return day }
        return "\(m)月\(d)日"
    }

    /**
     * 状態の言葉。**観測と判定を分ける。**
     *
     * `stalled` を「応答なし」と書いていた。観測しているのは最後に書き込んで
     * からの時間だけで、**相手が生きているかどうかは観測していない。**
     * 「更新なし」なら観測事実のままで、読む人が判断できる。
     *
     * 「作業中」と「実行中」を両方使っていたのもやめた。**画面から差が
     * 分からない語を二つ持たない。**
     */
    /**
     * 区切りの見出し。
     *
     * 9pt の添え字で出していたので、**見出しと本文の差が字の大きさで
     * ほとんど無く、画面が「似た文章の羅列」に見えていた** — 利用者の言葉
     * そのまま。区切りを罫線から間隔に変えたときに、間隔だけでは足りて
     * いなかった。
     *
     * 12pt・中太に上げ、見出しと数のあいだを罫で埋める。**この罫は装飾では
     * なく、見出しと数が同じ行に属することを言っている**（新聞の目次で
     * 使われる形）。カードで囲むより線が少なく、区切りは強い。
     */
    @discardableResult
    private func section(
        _ c: CGContext, _ title: String, count: String? = nil,
        countColour: NSColor? = nil, y: CGFloat, pad: CGFloat
    ) -> CGFloat {
        let baseline = y - 16
        text(title, at: CGPoint(x: pad, y: baseline), size: 12,
             colour: Palette.aside, weight: .semibold)
        let titleWidth = NSAttributedString(
            string: title,
            attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]
        ).size().width

        var right = bounds.maxX - pad
        if let count {
            text(count, at: CGPoint(x: right, y: baseline), size: 13,
                 colour: countColour ?? Palette.aside, mono: true, rightAt: right)
            right -= NSAttributedString(
                string: count,
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .medium)]
            ).size().width + 10
        }
        let from = pad + titleWidth + 10
        if right > from { rule(c, y: baseline + 7, from: from, to: right) }
        return y - 30
    }

    /**
     * 区画の見出しと、その下の細い線。
     *
     * 線は外周（`#484B4D`）より控えめな `#383639`。参考画像がそうなっている。
     */
    private func boardHeading(_ c: CGContext, _ title: String, y: CGFloat, pad: CGFloat) -> CGFloat {
        text(title, at: CGPoint(x: pad, y: y - 12), size: 9,
             colour: Palette.Board.subtle, weight: .semibold)
        let line = y - 18
        c.setFillColor(Palette.Board.divider.cgColor)
        c.fill(CGRect(x: pad, y: line, width: bounds.width - pad * 2, height: 1))
        return line - 11
    }

    /**
     * 一覧に出す一件。
     *
     * IRIS・Claude・Codex を**同じ一覧**に並べる。提供元ごとの区画は作らず、
     * アイコンだけが出どころを言う。件数も名前も出さない。
     */
    struct WorkRow {
        let icon: String
        /// 人が読める作業名。
        let title: String
        /// いま何をしているか。短く。
        let detail: String
        /// 経過。`今` か `N分`。
        let elapsed: String
        /// 並べ替えのための経過（分）。表示は文字、順番は数で決める。
        let waited: Int
        /**
         * 右端に出す状態。**全ての行が持つ。**
         *
         * 持たない行があると、点の位置が行ごとにずれる — 語の左に置いて
         * いたので、語の無い行だけ点が右に寄っていた。
         */
        enum State {
            /// 人の返事を待っている。**いま手が要る。**
            case waiting
            /// 誰も手を付けていない。日数が重さを言う。
            case untouched
            /**
             * 走ったことがあるのに、いま動いていない。**中断。**
             *
             * 未着手と分けるのは、**同じ日数でも次にやることが違う**から。
             * 手付かずのものは始めればいい。中断したものは、なぜ止まったかを
             * 見に行かないと始められない —— 途中まで進んだ何かが残っている。
             */
            case paused
            /// 動いている。
            case running
            /// 台帳が「止まっている」と言っている。**人が決めないと進まない。**
            case blocked
            /**
             * 生きているのを見た後、消えた。**開くまで残す。**
             *
             * 「完了」でも「中断」でもなく「終了」なのは、**こちらに区別が
             * 付かないから。**分かるのは、動いていたものが動いていない、
             * それだけ。どちらだったかは開けば分かる。
             */
            case ended
        }
        let state: State
        /**
         * 押したときに開く先。**開けないなら `nil`。**
         *
         * Claude と IRIS は URL。Codex は CLI しか入口が無いので、端末に
         * `codex resume <uuid>` を渡す。この機械に入っている端末は
         * Terminal.app だけ（実測）なので、選ばせるものは無い。
         */
        enum Door {
            case url(URL)
            case shell(String)
            /// アプリを前に出すだけ。**セッションまでは行かない。**
            case app(String)
        }
        let open: Door?
        /// 終了の控えから来た行だけが持つ。押したら控えから外すため。
        var endedId: String? = nil
    }

    /**
     * セッションから行を作る。
     *
     * **作業名が読めないものは出さない。**`iris-fd` のような機械的な識別子や、
     * 最初のプロンプトのパスを出すくらいなら、その行は無い方がいい
     * — 出したところで、どの作業か分からないので。
     */
    /// 机の上の IRIS。無ければ空。
    private var irisApp: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications/IRIS.app").path
    }

    private func workRows(_ all: Everything) -> [WorkRow] {
        var seen = Set<String>()
        var rows: [WorkRow] = []
        for session in all.sessions where session.live == true {
            /**
             * Codex の転記には `custom-title` が無い。あるのは最初の指示だけ。
             *
             * Claude ではそれを避けた（パスやコマンドが画面に出るので）が、
             * Codex には**ほかに人が読めるものが無い。**無いものを作るより、
             * あるものを短く出す。パスやコマンドに見えるものは弾く。
             */
            var readable = session.work
            if readable == nil, session.kind == "codex", let first = session.title {
                let looksMachine = first.hasPrefix("/") || first.hasPrefix("~")
                    || first.contains("://") || first.hasPrefix("cd ")
                if !looksMachine { readable = first }
            }
            guard let work = readable, !work.isEmpty else { continue }
            guard seen.insert(work).inserted else { continue }
            let minutes = session.busyMinutes ?? session.idleMinutes
            rows.append(WorkRow(
                icon: session.kind == "codex" ? "Codex" : "Claude",
                title: work,
                detail: session.doingNow ?? "",
                elapsed: minutes < 1 ? "今" : "\(minutes)分",
                waited: minutes,
                state: session.doing == "waiting" ? .waiting : .running,
                open: door(for: session)
            ))
        }
        /**
         * 終わった作業。**押されるまで残る。**
         *
         * 生きている行の後ろに置く。いま動いているものの方が先で、終わった
         * ものは「そういえば」の位置にある。
         */
        for row in ended {
            guard seen.insert(row.title).inserted else { continue }
            let minutes = Int(Date().timeIntervalSince(row.endedAt) / 60)
            rows.append(WorkRow(
                icon: "Claude", title: row.title,
                detail: "",
                elapsed: minutes < 1 ? "今" : (minutes < 60 ? "\(minutes)分" : "\(minutes / 60)時間"),
                waited: minutes,
                state: .ended,
                open: row.resume.map { _ in WorkRow.Door.app("Claude") },
                endedId: row.id
            ))
        }

        /**
         * IRIS の仕事は、委任した台帳から。
         *
         * `/api/portfolio` を読んでいたが、**そこに IRIS という企画は無い**
         * （あるのは Recall と NeuroAtlas だけ）。IRIS に投げた仕事は
         * `/api/dev/tasks` にあって、**盤はそれを一度も見ていなかった。**
         *
         * 経過は**依頼した日から**。実行の経過ではない — 14日前に受けて
         * 一度も動いていないものを「今」と書いたら、それは嘘になる。
         */
        let day = 86_400.0
        for task in (all.dev ?? []) where task.status == "in_progress" {
            guard seen.insert(task.title).inserted else { continue }
            var age = ""
            var ageMinutes = 0
            if let created = task.createdAt {
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let at = parser.date(from: created) ?? {
                    let plain = ISO8601DateFormatter()
                    plain.formatOptions = [.withInternetDateTime]
                    return plain.date(from: created)
                }() {
                    ageMinutes = Int(Date().timeIntervalSince(at) / 60)
                    let days = Int(Date().timeIntervalSince(at) / day)
                    age = days < 1 ? "今日" : "\(days)日"
                }
            }
            rows.append(WorkRow(
                icon: "Iris", title: task.title,
                detail: clip(task.goal ?? "", 30),
                elapsed: age,
                waited: ageMinutes,
                // 誰も手を付けていないまま日が経っているものは、見に行くべき。
                /*
                 * 三つを分ける。**走っている / 中断 / 未着手。**
                 *
                 * ここは `activeRuns == 0` を丸ごと「未着手」にしていた。
                 * 走った回数を見ていなかったので、**二度走って放置された
                 * ものが「手を付けていない」と表示されていた。**
                 */
                state: (task.activeRuns ?? 0) > 0
                    ? .running
                    : ((task.runCount ?? 0) > 0 ? .paused : .untouched),
                /**
                 * 開いている IRIS を前に出す。**新しく開かない。**
                 *
                 * `http://127.0.0.1:3002` を `NSWorkspace.open` に渡すと、
                 * **机に IRIS があっても毎回ブラウザに新しい窓が生える。**
                 * レールの印では同じことを直したのに、こちらは URL のまま
                 * だった — 同じ間違いを二箇所に置いていた。
                 */
                open: .app(irisApp)
            ))
        }
        /**
         * 返事を待っているものを上に。次に動いているもの、最後が未着手。
         *
         * **未着手を下に置くのは、14日待っているものが急ぎではないから**
         * ではなく、**いま手を動かせば進むもの**を先に見せるため。
         */
        func rank(_ state: WorkRow.State) -> Int {
            switch state {
            case .waiting: return 0
            case .running: return 2
            case .blocked: return 1
            /*
             * 中断は未着手より上。**途中まで進んだものが残っている**ので、
             * 戻れば早い。手付かずのものは、まだ何も無い。
             */
            case .paused: return 3
            case .untouched: return 4
            // 終わったものが一番下。手を動かして進むものが上に来る。
            case .ended: return 5
            }
        }
        /**
         * 群の中は**待たせている順**。
         *
         * これまで API が返した順のままだった — セッションは最終更新の順、
         * 委任した仕事は台帳の順で、**どちらも「どれだけ待たせているか」とは
         * 関係が無い。**利用者に順番を聞かれて、答えられなかった。
         *
         * 群の順（返事待ち → 実行中 → 未着手）は、いま手を動かせば進むものを
         * 先に見せるため。その中では長く待っているものが上。
         */
        return rows.sorted {
            rank($0.state) != rank($1.state)
                ? rank($0.state) < rank($1.state)
                : $0.waited > $1.waited
        }
    }

    /**
     * 一行。アイコン、作業名、作業内容、右端に状態。
     *
     * 確認が要るときだけ、作業名・経過・点・`確認待ち` が橙になる。
     * **行全体や背景は塗らない。**
     */
    /**
     * その道具の、そのセッションを開く手。
     *
     * Codex は `codex resume <uuid>` が UUID をそのまま受ける — 下位コマンドを
     * 見ていなくて「経路が無い」と報告したのは私の調べ落とし。Claude は
     * `claude://code/continue?session=<id>` で、**この形は Claude.app の中に
     * 実在するが、特定の id を受けるかは未確認**（見つかった用例は
     * `session=last` だけ）。開かなければ何も起きない。
     */
    private func door(for session: Session) -> WorkRow.Door? {
        guard let resume = session.resume, !resume.isEmpty else { return nil }
        if session.kind == "codex" { return .shell("codex resume \(resume)") }
        /**
         * Claude の机上アプリには、**特定のセッションを開く入口が無い。**
         *
         * `claude://code/…` にあるのは `continue?session=last`、`needs-input`、
         * `new` の三つだけで、`session` が UUID を受ける形は見つからない。
         * `continue?session=<uuid>` は `open` が 0 を返すが、**違うセッションが
         * 開くのと区別が付かない**ので使わない。
         *
         * 確認待ちの行だけは `needs-input` が意味として合う — 「入力を待って
         * いるものへ行け」で、その行が言っているのと同じこと。それ以外の行は
         * **入口を作らない。**押しても何も起きないが、**違うものを開くよりは
         * 何も起きない方がいい。**
         */
        /**
         * Claude はアプリを前に出すところまで。
         *
         * `claude://code/` には `continue?session=last` と `needs-input` と
         * `new` しかなく、**セッションを指定する形が存在しない**（記録で
         * 確かめた：押しは届き、`open` も走り、それでも画面は動かない）。
         *
         * 一度は「違うことをするくらいなら何もしない」としたが、利用者の
         * 判断で前に出すことにした。**セッションまでは行けない**ことは
         * 変わらない — そこは報告済みの制約として残る。
         */
        return .app("/Applications/Claude.app")
    }

    private func workRow(_ c: CGContext, y: CGFloat, row: WorkRow, pad: CGFloat) -> CGFloat {
        /**
         * 一行 46。62 から詰めた。
         *
         * 一画面に入る件数が少ないという指摘。字を小さくして行を詰めれば、
         * 同じ高さに三件が五件入る。
         */
        let height: CGFloat = 30
        let top = y - height

        /**
         * アイコンは本来の形のまま。
         *
         * レールでは円で抜いているが、あちらは輪の中に収めるため。ここは
         * 参考画像どおり、**角丸のシルエットをそのまま**置く。
         */
        let side: CGFloat = 20
        let box = NSRect(x: pad, y: top + (height - side) / 2, width: side, height: side)
        if row.icon == "Iris" {
            /**
             * レールの核を止めたものを、そのまま使う。
             *
             * 輪と芯を別に描いていたが、**同じものを二度描けば必ずずれる。**
             * 同じ場を同じ式で回して写し取れば、盤とレールで違う顔になる
             * 余地が無い。
             */
            /**
             * 核は少し大きく描く。
             *
             * 核の絵は外側に光の余白を持っていて、**同じ箱に入れると
             * アプリのアイコンより小さく見える** — あちらは絵が箱いっぱい
             * なので。見た目の大きさを揃えるために、箱の側を広げる。
             */
            CoreView.still(side: 44)?.draw(
                in: box.insetBy(dx: -2, dy: -2), from: .zero,
                operation: .sourceOver, fraction: 1
            )
        } else if let image = bundledIcon(row.icon) {
            image.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1)
        }

        let left = pad + side + 10
        // 右端に要る幅を先に取り、題名の幅を決める。重ならせない。
        /**
         * 右端は三つの列で固定する。
         *
         * 状態の語がある行と無い行で点の位置が違っていた（利用者いわく
         * 「青ランプを他のランプと位置揃えて」）。全ての行が同じ三列
         * — 点、語、経過 — を持てば、縦に揃う。
         */
        let rightEdge = bounds.maxX - pad
        let wordRight = rightEdge - 46
        let dotX = rightEdge - 116
        let room = max(40, dotX - 12 - left)

        /**
         * 題名は色を持たない。**状態の語と点だけ。**
         *
         * 確認待ちの行の題名まで橙にしていたので、七行のうち五行が橙になって
         * **画面が黄色っぽく、読んでいて疲れる**（利用者の言葉）。そして
         * 五行が同じ色なら、**その色はもう区別していない** — 今日 FDP で
         * 決めたのと同じ規則を、こちらでも破っていた。
         */
        /**
         * 状態ごとの色と語。
         *
         * `確認待ち` と `未着手` が同じ橙で、**見分けが付かなかった。**
         * 橙は「いま手が要る」に予約する — 返事を待っているものだけ。
         * 未着手は誰かの返事を待っているのではなく、**始まっていない**
         * だけなので、無彩色にして**日数に重さを持たせる**（14日と1日は
         * 同じ語でも別のこと）。動いているものは青。
         */
        let word: String
        let mark: NSColor
        switch row.state {
        case .waiting: word = "確認待ち"; mark = Palette.Board.amber
        case .untouched: word = "未着手"; mark = Palette.Board.subtle
        /*
         * 中断も無彩色。**橙は「いま手が要る」に予約してある。**
         *
         * 中断は返事を待っているのではなく、誰も戻ってきていない状態。
         * 急ぎかどうかは日数が言うので、色では言わない。
         */
        case .paused: word = "中断"; mark = Palette.Board.subtle
        case .running: word = "実行中"; mark = Palette.accent
        case .blocked: word = "動かせません"; mark = Palette.Board.amber
        case .ended: word = "終了"; mark = Palette.Board.subtle
        }
        let titleColour = Palette.Board.text
        /**
         * 題名も副行も、右端の手前で切る。
         *
         * 題名にだけ幅を渡していたので、**副行が右端の状態に潜り込んで
         * 文字が重なっていた。**同じ幅で切る。
         */
        text(fit(row.title, size: 11, weight: .semibold, width: room),
             at: CGPoint(x: left, y: top + height - 24), size: 12,
             colour: titleColour, weight: .semibold)
        /**
         * 副行をやめた。**題名で足りる。**
         *
         * 最後に頼まれたことを出していたが、「b」「g」のような一文字が
         * そのまま並ぶ — **人が読むためのものではなく、記録の断片**だった。
         * 題名は人が付けた（あるいは生成された）名前で、そちらだけで
         * どの作業か分かる。
         */

        text(row.elapsed, at: CGPoint(x: rightEdge, y: top + height / 2 - 7), size: 11,
             colour: Palette.Board.subtle, rightAt: rightEdge, weight: .medium)
        text(word, at: CGPoint(x: wordRight, y: top + height / 2 - 7), size: 10,
             colour: mark, rightAt: wordRight)
        c.setFillColor(mark.cgColor)
        c.fillEllipse(in: CGRect(x: dotX, y: top + height / 2 - 2.5, width: 5, height: 5))

        workRows.append((rect: NSRect(x: pad, y: top, width: bounds.width - pad * 2, height: height),
                         door: row.open, endedId: row.endedId))
        return top
    }

    /**
     * 与えられた幅に収まるところで切る。**文字数ではなく、実際の幅で。**
     *
     * 日本語は一文字の幅が均一ではないので、文字数で切ると同じ数でも
     * はみ出す行が出る。
     */
    private func fit(_ text: String, size: CGFloat, weight: NSFont.Weight, width: CGFloat) -> String {
        let font = NSFont.systemFont(ofSize: size, weight: weight)
        func measure(_ s: String) -> CGFloat {
            NSAttributedString(string: s, attributes: [.font: font]).size().width
        }
        if measure(text) <= width { return text }
        var kept = ""
        for character in text {
            if measure(kept + String(character) + "…") > width { break }
            kept.append(character)
        }
        return kept.isEmpty ? "" : kept + "…"
    }

    /// 束の中のアイコン。一度読んだら覚える。
    private static var icons: [String: NSImage] = [:]
    private func bundledIcon(_ name: String) -> NSImage? {
        if let held = Face.icons[name] { return held }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        Face.icons[name] = image
        return image
    }

    private func stateWord(_ doing: String) -> String {
        switch doing {
        case "working": return "実行中"
        case "waiting": return "判断待ち"
        case "stalled": return "更新なし"
        default: return "読めません"
        }
    }

    /// `3分` / `1時間`。分のままだと三桁になって読めない。
    private func span(_ minutes: Int) -> String {
        minutes < 60 ? "\(minutes)分" : "\(minutes / 60)時間"
    }

    /**
     * 手が要るセッション。**この盤で唯一、場所と色を持つ。**
     *
     * 名前だけでは足りない — 利用者いわく「iris だけ言われても iris のどの
     * 作業なのかわからない」。リポジトリと、最初に頼まれたことを添える。
     */
    private func attentionRow(
        _ c: CGContext, y: CGFloat, session: Session, all: Everything, pad: CGFloat
    ) -> CGFloat {
        var y = y
        text(
            clip(session.name ?? session.place, 14),
            at: CGPoint(x: pad, y: y - 16), size: 14, colour: Palette.headline
        )
        // 状態は見出しが言っている。行が言うのは、どれだけ待たせているか。
        text(
            span(session.idleMinutes),
            at: CGPoint(x: bounds.maxX - pad, y: y - 15), size: 11,
            colour: Palette.aside, rightAt: bounds.maxX - pad
        )
        y -= 24

        /**
         * 幅を渡して一行に収める。
         *
         * `text` は `draw(at:)` で幅を持たないので、**長い件名は窓の外へ出て
         * そこで消える。**折り返しの計算に任せて、はみ出させない。
         */
        var context = session.place
        if let title = session.title, !title.isEmpty { context += " · " + title }
        y -= wrapped(
            context, at: CGPoint(x: pad, y: y), width: bounds.width - pad * 2,
            size: 11, colour: Palette.aside, lines: 1
        ) + 10

        /**
         * 承認は、頼んでいるセッションの下に置く。
         *
         * 盤の最下部に置いていたので、**どのエージェントへの承認か分からない
         * まま押せた。**対応が取れないものは、取れないと書いて別に出す
         * — 間違った相手に結び付けるより、結び付けない方がいい。
         */
        if let ask = all.pending.first(where: { $0.sessionId.hasPrefix(session.id) }) {
            y -= wrapped(
                ask.summary ?? "\(ask.toolName) の実行許可を求めています",
                at: CGPoint(x: pad, y: y), width: bounds.width - pad * 2,
                size: 11, colour: Palette.headline, lines: 2
            ) + 10
        }
        y -= 8
        return y
    }

    /// それ以外。一行に潰す。色は付けない。
    private func quietRow(_ c: CGContext, y: CGFloat, session: Session, pad: CGFloat) -> CGFloat {
        text(
            clip(session.name ?? session.place, 18),
            at: CGPoint(x: pad, y: y - 13), size: 12, colour: Palette.headline
        )
        let minutes = session.busyMinutes ?? session.idleMinutes
        text(
            "\(span(minutes)) · \(session.place)",
            at: CGPoint(x: bounds.maxX - pad, y: y - 13), size: 11,
            colour: Palette.aside, rightAt: bounds.maxX - pad
        )
        return y - 22
    }

    private func rule(_ c: CGContext, y: CGFloat, from: CGFloat, to: CGFloat) {
        c.setFillColor(Palette.line.cgColor)
        c.fill(CGRect(x: from, y: y, width: to - from, height: 1))
        c.setFillColor(Palette.line.withAlphaComponent(0.10).cgColor)
        c.fill(CGRect(x: from, y: y - 3, width: to - from, height: 1))
    }

    /**
     * Brackets at the corners.
     *
     * Nothing about them is data, which is the objection to most HUD
     * ornament — but these are not pretending to be. They bound the surface,
     * the way a frame does, and the whole square gains a silhouette that a
     * rectangle of text does not have. Static, so they cost one path per draw
     * and nothing per second.
     */
    private func brackets(_ c: CGContext, inset: CGFloat, arm: CGFloat) {
        c.setStrokeColor(Palette.line.withAlphaComponent(0.55).cgColor)
        c.setLineWidth(1.2)
        c.setLineCap(.square)
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: inset, y: inset), 1, 1),
            (CGPoint(x: bounds.maxX - inset, y: inset), -1, 1),
            (CGPoint(x: inset, y: bounds.maxY - inset), 1, -1),
            (CGPoint(x: bounds.maxX - inset, y: bounds.maxY - inset), -1, -1),
        ]
        for (corner, dx, dy) in corners {
            c.move(to: CGPoint(x: corner.x + arm * dx, y: corner.y))
            c.addLine(to: corner)
            c.addLine(to: CGPoint(x: corner.x, y: corner.y + arm * dy))
        }
        c.strokePath()
    }

    private func text(
        _ string: String, at point: CGPoint, size: CGFloat, colour: NSColor,
        mono: Bool = false, centre: CGFloat? = nil, rightAt: CGFloat? = nil,
        weight: NSFont.Weight = .regular
    ) {
        let font = mono
            ? NSFont.monospacedSystemFont(ofSize: size, weight: .medium)
            : NSFont.systemFont(ofSize: size, weight: weight)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: colour,
            /**
             * 字間を広げない。
             *
             * 等幅を字間広めで置くと、**端末やログ画面の見た目**になる。
             * 数字を揃えるのに要るのは等幅であることで、字間ではない。
             */
            .kern: 0,
        ]
        let drawn = NSAttributedString(string: string, attributes: attributes)
        var origin = point
        if let centre { origin.x = centre - drawn.size().width / 2 }
        if let rightAt { origin.x = rightAt - drawn.size().width }
        drawn.draw(at: origin)
    }

    /**
     * 幅を決めて折り返す。使った高さを返す。
     *
     * `text` は `draw(at:)` で、**幅という概念を持っていない** — 長い文は
     * 窓の外へ出ていって、そこで消える。「明日は 18:00 から「チーフ講」
     * のように、**文が途中で切れているのに、切れたことは画面に出ない。**
     *
     * 返り値で高さを渡すのは、二行になったかどうかを呼び出し側が推測しない
     * ため。折り返しの計算が二箇所にあれば、必ずずれる。
     */
    @discardableResult
    private func wrapped(
        _ string: String, at point: CGPoint, width: CGFloat, size: CGFloat,
        colour: NSColor, weight: NSFont.Weight = .regular, lines: Int = 3
    ) -> CGFloat {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: colour,
            .paragraphStyle: style,
        ]
        let limit = (size + 5) * CGFloat(lines)
        let measured = NSString(string: string).boundingRect(
            with: NSSize(width: width, height: limit),
            options: [.usesLineFragmentOrigin], attributes: attributes
        )
        let height = min(ceil(measured.height), limit)
        NSAttributedString(string: string, attributes: attributes).draw(
            in: NSRect(x: point.x, y: point.y - height, width: width, height: height)
        )
        return height
    }
}

// MARK: - Showing it

final class Controller: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let reader = Reader()
    private var timer: Timer?
    private var latest: Snapshot = .unreachable("読み込み中")
    private var strip: Strip?
    /// 中央のノッチ。`HudShape.notch` のときだけ生きている。
    private var notch: Notch?

    /**
     * 一度でも読めたか。
     *
     * 起動直後の一回目が返るまで、レールは「読めない」ではなく「読み込み中」
     * を出す。**同じ見た目にしてはいけない** — 点線は、待っても変わらない
     * という意味だから。一度読めたあとは二度と戻さない：そこから先の失敗は
     * 本当に失敗で、読み込み中ではない。
     */
    private var everRead = false

    /**
     * IRIS の側から声をかける口。
     *
     * 押されたら盤を開く —— **報せを読んで、次に何を見るかまでを一続きにする。**
     */
    private lazy var notifier = Notifier(onOpen: { [weak self] in
        // 閉じているときだけ開く。**開いているものを閉じてしまわない。**
        guard let self, self.board == nil else { return }
        self.toggleBoard()
    })
    /**
     * **使用量を一度でも読めたか。**`everRead` とは別に持つ。
     *
     * ブリーフィング全体が `.ready` になっても、その中の `usage` は遅れて
     * 来る（Claude の割合は端末が置いていくファイル、Codex は会話の記録の
     * 走査）。`.ready` になった時点で `loading: false` を渡していたので、
     * **起動から1〜2分、レールは点線と `—` を出していた** —— それは
     * 「本当に読めない」と同じ顔で、この機械がいちばん避けたい形。
     * 実測 2026-09-10、撮り直しが二回要った。
     *
     * 一度読めたあとに `nil` になるのは本当の失敗なので、そこは点線でよい。
     * 区別したいのは**まだ来ていない**の一回だけ。
     */
    private var everReadUsage = false

    /// 取り直しを頼んだ時点での、Claude の値の古さ。新しくなったかの判定に使う。
    private var reloadFrom: Int?
    /**
     * いま回しているかどうか。**`reloadFrom` とは別に持つ。**
     *
     * 止める判断を `reloadFrom != nil` で代用していたが、これは「読めていた
     * ときの古い値」で、**まだ一度も読めていなければ入らない。**そこから
     * 回し始めると、40秒の強制停止まで含めて全部が入口で弾かれ、輪が永久に
     * 回り続けた。回っているかどうかは、回し始めたかどうかで決める。
     */
    private var reloading = false

    /**
     * 最後に読めた空模様。
     *
     * 取りに行っているあいだ、天気は一瞬だけ消える。それをそのままレールへ
     * 渡していたので、**列の高さが 44 ポイント縮んで、また戻る** — 利用者に
     * は「レールが消える」と見えていた。
     *
     * 読めた値を持っておいて、無い間はそれを出す。**古くなったら消える**
     * のはサーバ側（二時間で捨てる）が決めることで、こちらは往復のたびに
     * 画面を揺らさないだけ。
     */
    private var lastSky = Sky(nil)

    private var board: Dashboard?
    /// 右辺の使用量レール。帯とは別に開け閉めする。
    private var rail: Rail?
    private var pointer: Any?
    private var localPointer: Any?
    private var ask: Ask?
    private var schedule: Schedule?
    private var day: Day?
    private let hotkeys = Hotkeys()

    /// Long enough not to fire on a normal press, short enough not to feel held.
    private static let holdThreshold: TimeInterval = 0.28
    private var holdTimer: Timer?
    private var talking = false
    private var heldLongEnough = false
    private var coverReport: Timer?

    /**
     * Listening all the time, or not.
     *
     * A deliberate switch with a visible label rather than something that turns
     * itself on. An open microphone is a thing a person should have decided,
     * and be able to see they decided.
     */
    fileprivate var ambient: Bool {
        get { UserDefaults.standard.bool(forKey: "ambient") }
        set { UserDefaults.standard.set(newValue, forKey: "ambient") }
    }
    private var stillCore: Bool {
        get { UserDefaults.standard.bool(forKey: "core.still") }
        set { UserDefaults.standard.set(newValue, forKey: "core.still") }
    }
    /// Remembered across launches, because a strip the person dismissed should
    /// stay dismissed rather than come back with the next login.
    private var railVisible: Bool {
        get { UserDefaults.standard.bool(forKey: "rail") }
        set { UserDefaults.standard.set(newValue, forKey: "rail") }
    }

    private var stripVisible: Bool {
        get { UserDefaults.standard.object(forKey: "strip") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "strip") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = mark()
        item.button?.title = ""
        item.menu = NSMenu()
        item.menu?.delegate = self

        if railVisible { toggleRail() }
        applyShape()
        bindKeys()

        /**
         * Asks for the location once, at launch, rather than the first time an
         * appointment comes into range.
         *
         * The prompt would otherwise arrive three hours before a meeting, on
         * top of whatever was on screen, about a feature nobody was thinking
         * about. Here it lands next to the thing that is asking for it.
         */
        Travel.shared.start()

        refresh()
        // Slow on purpose. The ledger is edited by hand and agents take
        // minutes; a fast poll would spend battery to show the same string.
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        reader.read { [weak self] snapshot in
            guard let self else { return }
            self.latest = snapshot
            if case let .ready(all) = snapshot {
                /*
                 * 先回りの提案を、**こちらから届ける。**
                 *
                 * 規則は前から発火していた。届く先が無かっただけで —— 提案は
                 * 積まれ、画面と盤が取りに行くのを待っていた。見に行かなければ
                 * 何も知らされない。期限を13日過ぎた課題が黙っていたのは、
                 * 条件を直したあとは「発火している、届いていない」だった。
                 */
                self.notifier.deliver(all.suggestionList)
            }
            if case .ready = snapshot {
                self.everRead = true
            } else if !self.everRead {
                /**
                 * 最初の一回が失敗したら、四十五秒待たずに聞き直す。
                 *
                 * 起動の順番は決まっていない — HUD が先に上がって、IRIS が
                 * まだ立ち上がっている最中ということは普通に起きる。次の巡回
                 * まで待つと、**うまくいっていても四十五秒回り続ける**。
                 * 回っているものが長く回っていると、それはもう「動いていない」
                 * の顔になる。
                 *
                 * 一度読めたあとは巡回に任せる。そこから先の失敗は本当の失敗で、
                 * 急いで聞き直すようなことではない。
                 */
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    guard let self, !self.everRead else { return }
                    self.refresh()
                }
            }
            self.item.button?.title = ""
            self.item.button?.toolTip = self.title(for: snapshot)
            /*
             * 控えは**描画より先、盤の外で**。盤の中で突き合わせていたので、
             * ダッシュボードを開いているあいだしか記録されず、**見ていない
             * あいだの終了が落ちていた** — それを拾うための仕組みだったのに。
             */
            if case let .ready(all) = snapshot { EndedLedger.shared.note(all.sessions) }
            self.strip?.show(snapshot)
            self.notch?.show(snapshot)
            self.board?.show(snapshot)
            /**
             * 読めても読めなくても、そのつど描き直す。
             *
             * `.ready` のときだけ描いていたので、途中で IRIS が落ちても
             * レールは最後に読めた数字を出したままだった。**古い数字が
             * 現在の数字の顔をしている**のが、この機械が名前で嫌っている形。
             */
            self.finishReload(force: false)
            let head = self.railHead(for: snapshot)
            if case .ready(let all) = snapshot {
                if all.usage != nil { self.everReadUsage = true }
                // まだ一度も来ていないなら、読めないのではなく待っている。
                self.rail?.show(
                    railEntries(from: all.usage),
                    head: head,
                    loading: all.usage == nil && !self.everReadUsage
                )
            } else {
                self.rail?.show(railEntries(from: nil), head: head, loading: !self.everRead)
            }
        }
    }

    /**
     * The one line.
     *
     * Ordered by what would make someone look: a run in flight first, then
     * anything the ledger could not read, then work that is stopped, and only
     * then the ordinary count. The last of those is the common case and the
     * least urgent, which is why it is last.
     */
    /**
     * メニューバーの印。文字は出さない。
     *
     * `IRIS 14/18 ·1停` と出していた。**同じことをレールが、輪と数字で
     * 言っている** — 利用者いわく「帯とかがある以上これいらない」。
     * メニューバーは幅が限られていて、他のアプリの印と並ぶ場所でもある。
     *
     * 項目そのものは消せない。ここが献立（IRIS を開く、形の切り替え、終了）
     * の入口なので。だから**入口だけ残して、報告はやめる。**文言は
     * ツールチップに残す — 押さずに確かめたいときのために。
     */
    private func mark() -> NSImage {
        let side: CGFloat = 16
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
            let inset: CGFloat = 2.5
            let box = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
            let ring = NSBezierPath(ovalIn: box)
            ring.lineWidth = 1.6
            NSColor.black.setStroke()
            ring.stroke()
            let core = box.insetBy(dx: 3.6, dy: 3.6)
            NSColor.black.setFill()
            NSBezierPath(ovalIn: core).fill()
            return true
        }
        // テンプレートにすると、明暗どちらのメニューバーでも系統色で描かれる。
        image.isTemplate = true
        return image
    }

    private func title(for snapshot: Snapshot) -> String {
        switch snapshot {
        case .unreachable:
            return "IRIS ✕"
        case .unreadable:
            return "IRIS ⚠"
        case let .ready(all):
            if all.approvals > 0 { return "IRIS !\(all.approvals)" }
            let running = all.runs.filter { $0.state == "running" }.count
            if running > 0 { return "IRIS ⟳\(running)" }

            let projects = all.portfolio.projects ?? []
            let unknown = projects.reduce(0) { $0 + $1.progress.unknown }
            if unknown > 0 { return "IRIS ⚠\(unknown)" }

            let done = projects.reduce(0) { $0 + $1.progress.done }
            let total = projects.reduce(0) { $0 + $1.progress.total }
            let blocked = projects.reduce(0) { $0 + $1.progress.blocked }
            return blocked > 0 ? "IRIS \(done)/\(total) ·\(blocked)停" : "IRIS \(done)/\(total)"
        }
    }
}

// MARK: - The menu

extension Controller: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        switch latest {
        case let .unreachable(why):
            add(menu, why, enabled: false)
            add(menu, "IRIS が起動しているか確認してください", enabled: false, small: true)
        case let .unreadable(why):
            add(menu, "台帳を読めません", enabled: false)
            add(menu, why, enabled: false, small: true)
        case let .ready(all):
            build(menu, all.portfolio, all.runs)
        }

        menu.addItem(.separator())
        let open = NSMenuItem(title: "IRIS を開く", action: #selector(raiseIris), keyEquivalent: "i")
        open.keyEquivalentModifierMask = [.option, .command]
        open.target = self
        menu.addItem(open)

        let question = NSMenuItem(title: "IRIS に聞く", action: #selector(openAsk), keyEquivalent: "a")
        question.keyEquivalentModifierMask = [.option, .command]
        question.target = self
        menu.addItem(question)

        /**
         * レールの開け閉めを献立にも出す。
         *
         * `⌥⌘R` は最初からあったが、**どこにも書いていなかった。**押し方を
         * 知っている人しか使えない機能は、無いのとあまり変わらない。
         */
        let railItem = NSMenuItem(
            title: rail == nil ? "レールを表示" : "レールを隠す",
            action: #selector(toggleRail), keyEquivalent: "r"
        )
        railItem.keyEquivalentModifierMask = [.option, .command]
        railItem.target = self
        menu.addItem(railItem)

        let shape = NSMenuItem(
            title: "形：\(HudShape.current.label) → \(HudShape.current.next.label)",
            action: #selector(cycleShape), keyEquivalent: ""
        )
        shape.target = self
        menu.addItem(shape)

        let boardItem = NSMenuItem(
            title: board == nil ? "進捗を開く" : "進捗を閉じる",
            action: #selector(toggleBoard), keyEquivalent: "d"
        )
        boardItem.keyEquivalentModifierMask = [.option, .command]
        boardItem.target = self
        menu.addItem(boardItem)

        let listen = NSMenuItem(
            title: ambient ? "常時待ち受けを止める" : "常時待ち受けにする",
            action: #selector(toggleAmbient), keyEquivalent: ""
        )
        listen.target = self
        menu.addItem(listen)

        let motion = NSMenuItem(
            title: stillCore ? "コアを動かす" : "コアを止める",
            action: #selector(toggleCoreMotion), keyEquivalent: ""
        )
        motion.target = self
        menu.addItem(motion)
        let reload = NSMenuItem(title: "更新", action: #selector(reloadNow), keyEquivalent: "r")
        reload.target = self
        menu.addItem(reload)
        /**
         * Asks for a fresh allowance figure.
         *
         * It costs about two cents and six seconds, and the objection to
         * automating it — that a meter should not spend what it measures —
         * turned out to be answerable with a measurement: two consecutive
         * refreshes did not move the seven-day figure at all. So the
         * dashboard refreshes on its own when the number is an hour old, and
         * this item is for wanting it now.
         */
        let refresh = NSMenuItem(
            title: "使用量を更新", action: #selector(refreshAllowance), keyEquivalent: ""
        )
        refresh.target = self
        menu.addItem(refresh)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func build(_ menu: NSMenu, _ portfolio: Portfolio, _ runs: [AgentRun]) {
        let running = runs.filter { $0.state == "running" }
        if !running.isEmpty {
            add(menu, "動いているもの", enabled: false, header: true)
            for run in running {
                add(menu, "  \(run.agent ?? "agent") · \(run.branch)")
            }
            menu.addItem(.separator())
        }

        for project in portfolio.projects ?? [] {
            let p = project.progress
            add(menu, "\(project.id ?? "") \(project.name)  \(p.done)/\(p.total)", enabled: false, header: true)

            // Unfinished only. A finished task is not a thing to look at.
            let open = project.tasks.filter { $0.status != "Done" }
            if open.isEmpty {
                add(menu, "  残りなし", enabled: false, small: true)
            }
            for task in open.prefix(4) {
                let mark = task.status == "Blocked" ? "停" : task.status == "In Progress" ? "進" : "未"
                add(menu, "  [\(mark)] \(task.id ?? "") \(clip(task.title, 30))")
                // For a blocked task the release condition is the whole point
                // of looking, so it is shown rather than hidden behind a click.
                if task.status == "Blocked", !task.notes.isEmpty {
                    add(menu, "        \(clip(task.notes, 46))", enabled: false, small: true)
                }
            }
            menu.addItem(.separator())
        }

        let stray = (portfolio.repos ?? []).filter { !$0.registered && $0.lastCommit != nil }
        if !stray.isEmpty {
            add(menu, "台帳にないもの", enabled: false, header: true)
            for repo in stray.prefix(4) {
                add(menu, "  \(clip(repo.name, 28))  \(repo.lastCommit ?? "")", enabled: false, small: true)
            }
        }

        for warning in portfolio.warnings ?? [] {
            add(menu, "⚠ \(clip(warning, 44))", enabled: false, small: true)
        }
    }

    private func add(_ menu: NSMenu, _ text: String, enabled: Bool = true, header: Bool = false, small: Bool = false) {
        let entry = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        entry.isEnabled = enabled
        if header || small {
            let size: CGFloat = small ? 11 : 12
            let weight: NSFont.Weight = header ? .semibold : .regular
            entry.attributedTitle = NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: size, weight: weight),
                    .foregroundColor: small ? NSColor.secondaryLabelColor : NSColor.labelColor,
                ]
            )
        }
        menu.addItem(entry)
    }

    /// Truncated on characters, so Japanese counts the way it looks.
    private func clip(_ text: String, _ limit: Int) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count <= limit ? flat : String(flat.prefix(limit)) + "…"
    }

    /**
     * 開いている IRIS を前に出す。無いときだけ開く。
     *
     * `NSWorkspace.open(url)` は毎回ブラウザに新しい窓を渡すので、机の上に
     * すでに IRIS があっても構わず二枚目が生える — 押した人が欲しいのは
     * 「新しい IRIS」ではなく「さっきの IRIS」。
     *
     * 識別子は焼き込まない。IRIS は Safari の web アプリとして作られていて、
     * 作り直すたびに識別子が変わる。束から読めば、そのとき机にあるものと
     * 必ず一致する。
     */
    @objc private func openIris() {
        let app = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications/IRIS.app")
        if let identifier = Bundle(url: app)?.bundleIdentifier,
           let running = NSRunningApplication
               .runningApplications(withBundleIdentifier: identifier).first {
            running.activate(options: [.activateAllWindows])
            return
        }
        if FileManager.default.fileExists(atPath: app.path) {
            NSWorkspace.shared.openApplication(at: app, configuration: .init())
            return
        }
        if let url = URL(string: "http://127.0.0.1:3002") { NSWorkspace.shared.open(url) }
    }

    @objc private func reloadNow() { refresh() }

    private func openStrip() {
        let panel = Strip()
        panel.setCoreStill(stillCore)
        panel.show(latest)
        panel.orderFrontRegardless()
        strip = panel

        panel.onPress = { [weak self] in self?.toggleBoard() }

        // Tell the application how much of its top the band is covering, and
        // keep saying so — the report expires, so a band that dies without a
        // word does not leave a gap behind it.
        post("/api/hud/strip", ["height": 58])
        coverReport?.invalidate()
        coverReport = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self, self.strip != nil else { return }
            self.post("/api/hud/strip", ["height": 58])
        }

        /**
         * The pointer decides whether the band is solid.
         *
         * Only while the cursor is over the left end does the window stop
         * ignoring mouse events, so a press there is consumed by the band and
         * never reaches the application underneath. The rest of the width stays
         * transparent to clicks for the whole time.
         *
         * Driven by a monitor rather than a tracking area because the band
         * ignores mouse events most of the time, and a window that ignores them
         * gets no mouse-entered either — the tracking area would only start
         * working once it was already unnecessary.
         */
        if pointer == nil {
            let follow: (NSEvent?) -> Void = { [weak self] _ in
                guard let self, let band = self.strip else { return }
                let at = NSEvent.mouseLocation
                let handle = NSRect(
                    x: band.frame.minX, y: band.frame.minY,
                    width: Strip.handleWidth, height: band.frame.height
                )
                let overHandle = handle.contains(at)
                band.setHandleActive(overHandle)
                // Yields for the rest of the width, never for the handle.
                band.setYielding(!overHandle && band.frame.contains(at))
            }
            pointer = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: follow)
            localPointer = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { event in
                follow(event)
                return event
            }
        }
    }

    /**
     * Pressing the band opens the square, not a menu.
     *
     * A system menu was what it did first, and it looked like a system menu —
     * which is to say like the operating system rather than like IRIS. The
     * settings that used to live in it are rarely touched; the dashboard is the
     * thing wanted often. So the frequent action gets the press, and the rare
     * ones stay in the status item, which is reachable whenever the menu bar is.
     */
    /**
     * The three shortcuts.
     *
     * `⌥⌘` rather than `⌘` or `⌃⌘`, which collide with almost everything. This
     * set still collides with one thing worth naming: `⌥⌘I` opens the developer
     * tools in Chrome and Safari. It is taken here because IRIS is the thing
     * being reached for far more often than an inspector, and because a global
     * hotkey wins — the browser simply never sees it. Say so rather than let it
     * be discovered.
     */
    private func bindKeys() {
        let optionCommand = optionKey | cmdKey
        hotkeys.bind(kVK_ANSI_I, optionCommand, "⌥⌘I") { [weak self] in self?.raiseIris() }
        hotkeys.bind(kVK_ANSI_D, optionCommand, "⌥⌘D") { [weak self] in self?.toggleBoard() }
        // The band. `B` rather than `S`, which is Save As in enough places to
        // be worth avoiding for something pressed by reflex.
        hotkeys.bind(kVK_ANSI_R, optionCommand, "⌥⌘R") { [weak self] in self?.toggleRail() }
        hotkeys.bind(kVK_ANSI_N, optionCommand, "⌥⌘N") { [weak self] in self?.openSchedule() }
        /*
         * 一日の形。`K` は「今日」。
         *
         * `T` を避けた —— Finder と Mail の**ツールバーの表示切り替え**が
         * `⌥⌘T` で、大域の hotkey は前面のアプリより先に取るので、あちらが
         * 二度と効かなくなる。`K` は `⌘K` こそ埋まっているものの
         * （Slack の切り替え、VS Code の連鎖）、`⌥⌘K` はどれも取っていない。
         */
        hotkeys.bind(kVK_ANSI_K, optionCommand, "⌥⌘K") { [weak self] in self?.toggleDay() }
        /**
         * Tap to type, hold to speak.
         *
         * One key for both because they are the same intention — say something
         * to IRIS — and a second shortcut for the second half would be another
         * combination to remember and another to collide with something.
         *
         * The threshold decides which. Held past it, the microphone opens and
         * closes with the key, so the moment it is listening is the moment a
         * finger is down: nothing is recorded that was not asked for, and there
         * is no state to forget to turn off. Released before it, nothing was
         * ever opened and the line to type into appears instead.
         */
        trace("bindKeys")
        hotkeys.bind(
            kVK_ANSI_A, optionCommand, "⌥⌘A",
            { [weak self] in self?.beginTalk() },
            released: { [weak self] in self?.endTalk() }
        )
        for name in hotkeys.failures {
            NSLog("IRIS: %@ is taken by something else and will not reach IRIS", name)
        }
    }

    /**
     * Brings IRIS forward, wherever it already is.
     *
     * Opening the URL unconditionally would leave a second window every time
     * the key was pressed, which is the opposite of what a shortcut for
     * "show me IRIS" should do. So: a running application by that name is
     * activated; failing that the installed web app is launched; failing that
     * the URL goes to whatever the person browses with. Each step is a fallback
     * for the one before, and the last always works.
     */
    @objc private func raiseIris() {
        let running = NSWorkspace.shared.runningApplications.first {
            $0.localizedName == "IRIS" && $0.bundleIdentifier != Bundle.main.bundleIdentifier
        }
        if let running {
            running.activate(options: [.activateAllWindows])
            return
        }
        let installed = URL(fileURLWithPath: NSHomeDirectory() + "/Applications/IRIS.app")
        if FileManager.default.fileExists(atPath: installed.path) {
            NSWorkspace.shared.openApplication(at: installed, configuration: .init())
            return
        }
        if let url = URL(string: "http://127.0.0.1:3002") { NSWorkspace.shared.open(url) }
    }

    /**
     * Opens the microphone on the press, not after the threshold.
     *
     * The first version waited 0.28 seconds to see whether this was a hold, and
     * only then asked the recogniser to start — which then takes its own moment
     * to be ready. Measured against the helper's own log, a real press produced
     * `ready` at 09:13:33.976 and `stopped` at 09:13:35.481: the microphone was
     * open for a second and a half, and the beginning of the sentence was
     * already gone before it opened.
     *
     * So it opens immediately and the threshold decides only what to do on the
     * way out. A tap costs one start/stop pair the recogniser discards, which
     * is cheaper than losing the first word of every request.
     */
    private func beginTalk() {
        trace("beginTalk talking=\(talking) strip=\(strip != nil)")
        /**
         * A press while already talking is a stuck state, not a second press.
         *
         * `endTalk` is the only thing that clears the flag, and it runs from
         * the key-release event. If that event does not arrive — and whether it
         * does was never verified — the flag stays true and every press after
         * the first is silently refused. Recovering is better than refusing:
         * the microphone is closed either way, so the worst case is one extra
         * stop request.
         */
        if talking {
            trace("stuck: recovering")
            talking = false
            holdTimer?.invalidate()
            holdTimer = nil
            // Only if it was ever opened. Before the threshold there is no
            // microphone to close, and a stop sent then is what raced the
            // start in the first place.
            if heldLongEnough { post("/api/speech/stop", [:]) }
            heldLongEnough = false
            strip?.saySpeaking(false)
            return
        }
        talking = true
        heldLongEnough = false

        /**
         * Nothing is opened yet.
         *
         * The comment above this function says the microphone opens when the
         * key is *held* past the threshold, and the code opened it on the
         * press — so a tap, which is the gesture for "give me a line to type
         * into", also switched on the microphone. Two things started for one
         * intention, and the person saw both.
         *
         * It also produced the second fault. A tap posted `stop` immediately,
         * and the recogniser takes about two seconds to come up: the stop
         * arrived while the start was still in flight, the start then
         * completed, and the microphone was left open with nothing to close
         * it. Two symptoms, one cause — the decision about which gesture this
         * is was being made after the thing it decides.
         *
         * So the microphone waits for the threshold, and a tap never touches
         * it at all.
         */
        /**
         * Says "getting ready" until it actually is.
         *
         * The recogniser takes about two seconds from the request to the first
         * captured audio — measured: `start` at 09:44:14.253, the helper's own
         * `ready` at 09:44:16. Saying "listening" during that window is a lie
         * that costs the person the beginning of their sentence, and it is why
         * the first real attempt produced nothing: three seconds held, two of
         * them spent starting up, spoken into the part that was not recording.
         *
         * It cannot be made instant while the microphone is closed between
         * requests — which is the trade for it being closed at all. So the band
         * says which of the two states it is in, and the person waits for the
         * word.
         */
        holdTimer = Timer.scheduledTimer(withTimeInterval: Self.holdThreshold, repeats: false) {
            [weak self] _ in
            guard let self, self.talking else { return }
            self.heldLongEnough = true
            self.holdTimer = nil

            // `push`: while the key is down every word is meant for IRIS, so
            // the name is not required. The server applies the stricter rule
            // by default and only relaxes it because this asked.
            self.post("/api/speech/start", ["mode": "push"])
            /**
             * Says "getting ready" until it actually is.
             *
             * The recogniser takes about two seconds from the request to the
             * first captured audio — measured: `start` at 09:44:14.253, the
             * helper's own `ready` at 09:44:16. Saying "listening" during that
             * window is a lie that costs the person the beginning of their
             * sentence.
             */
            self.strip?.sayPreparing()
            self.waitUntilListening(attempt: 0)
        }
    }

    private func waitUntilListening(attempt: Int) {
        guard talking, attempt < 25 else { return }
        guard let url = URL(string: "http://127.0.0.1:3002/api/speech/status") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self, self.talking else { return }
                let body = data.flatMap {
                    try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                }
                if (body?["state"] as? String) == "listening" {
                    self.strip?.saySpeaking(true)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    self.waitUntilListening(attempt: attempt + 1)
                }
            }
        }.resume()
    }

    private func endTalk() {
        trace("endTalk talking=\(talking) held=\(heldLongEnough)")
        holdTimer?.invalidate()
        holdTimer = nil
        guard talking else { return }
        talking = false
        strip?.saySpeaking(false)

        /**
         * Kept open a moment past the release.
         *
         * Recognition lags the audio: the last word is still being turned into
         * text when the finger comes up. Closing on the exact edge truncates
         * every request by however long that takes.
         */
        let tapped = !heldLongEnough

        // Released before the threshold: the microphone was never asked for,
        // so there is nothing to close. A stop here was what raced the start
        // and left it open.
        if tapped {
            openAsk()
            return
        }

        /**
         * Kept open a moment past the release.
         *
         * Recognition lags the audio: the last word is still being turned into
         * text when the finger comes up. Closing on the exact edge truncates
         * every request by however long that takes.
         */
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            self?.post("/api/speech/stop", [:])
        }

        strip?.sayThinking()
        awaitAnswer(from: Date())
    }

    /**
     * Waits for the turn the microphone started, and says what came of it.
     *
     * Polled rather than pushed because the band has no connection held open,
     * and the alternative — saying nothing until the next 45-second tick —
     * would leave a person who has just spoken looking at a line that has not
     * acknowledged them. Silence after speaking is indistinguishable from not
     * having been heard.
     *
     * It gives up after thirty seconds and says so, rather than waiting
     * forever on an answer that may never come.
     */
    private func awaitAnswer(from asked: Date, attempt: Int = 0) {
        guard attempt < 30 else {
            strip?.sayAnswer("返答がありませんでした。", "IRIS を開いて確認してください。")
            return
        }
        guard let url = URL(string: "http://127.0.0.1:3002/api/speech/voice") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                let body = data.flatMap {
                    try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                }
                let last = body?["last"] as? [String: Any]
                let at = (last?["at"] as? String).flatMap(ISO8601DateFormatter().date(from:))
                // Only an event newer than the press. An older one is the
                // previous request, and showing it would answer the wrong
                // question.
                let fresh = at.map { $0 > asked.addingTimeInterval(-1) } ?? false

                if fresh, let last, let type = last["type"] as? String {
                    let heard = (last["text"] as? String) ?? ""
                    switch type {
                    case "voice.heard":
                        // Shown while the answer is still being written, so a
                        // mis-hearing is visible before it is acted on.
                        self.strip?.sayHeard(heard)
                    case "voice.answered":
                        let reply = (last["reply"] as? String) ?? ""
                        self.strip?.sayAnswer(heard, reply)
                        // Kept whole for the panel, which can scroll. The band
                        // has two lines and most answers are longer.
                        self.ask?.hold(question: heard, reply: reply)
                        return
                    case "voice.approval":
                        self.strip?.sayAnswer(
                            "承認が必要です。",
                            "\((last["tool"] as? String) ?? "") — IRIS を開いて確認してください。"
                        )
                        return
                    case "voice.failed":
                        self.strip?.sayAnswer("届きませんでした。", (last["message"] as? String) ?? "")
                        return
                    default: break
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.awaitAnswer(from: asked, attempt: attempt + 1)
                }
            }
        }.resume()
    }

    private func post(_ path: String, _ body: [String: Any]) {
        guard let url = URL(string: "http://127.0.0.1:3002" + path) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request).resume()
    }

    /**
     * Listening all the time, or not.
     *
     * Kept as a deliberate switch with a visible label rather than something
     * that turns itself on. An open microphone is a thing a person should have
     * decided, and be able to see they decided.
     */
    @objc private func toggleAmbient() {
        ambient.toggle()
        if ambient {
            post("/api/speech/start", ["mode": "ambient"])
        } else {
            post("/api/speech/stop", [:])
        }
    }

    /**
     * 予定を打つ窓。
     *
     * 聞く窓とは分けてある。あちらは**問い、答え、忘れる**。こちらは
     * **打つ、確かめる、入れる**で、最後に相手の側へ物が残る。同じ窓に
     * 混ぜると、確認の段が「答えを待っているところ」に見える。
     */
    /// 開けた鍵で閉じられる。`Ask` と同じ作り。
    @objc func toggleDay() {
        if day == nil { day = Day() }
        if day?.isVisible == true {
            day?.dismiss()
            return
        }
        day?.present()
    }

    @objc func openSchedule() {
        if schedule == nil { schedule = Schedule() }
        schedule?.present()
    }

    @objc private func openAsk() {
        if ask == nil { ask = Ask() }
        // A voice answer waiting to be read opens straight to it.
        if ask?.isVisible != true, ask?.hasHeld == true {
            ask?.presentHeld()
            return
        }
        // A second press closes it. The key that opens a thing should be able
        // to put it away.
        if ask?.isVisible == true {
            ask?.dismiss()
            return
        }
        ask?.present()
    }

    @objc private func toggleBoard() {
        if let open = board {
            open.orderOut(nil)
            board = nil
            return
        }
        let panel = Dashboard()
        panel.ambient = { [weak self] in self?.ambient ?? false }
        panel.stillCore = { [weak self] in self?.stillCore ?? false }
        panel.onListen = { [weak self] in self?.toggleAmbient() }
        panel.onMotion = { [weak self] in self?.toggleCoreMotion() }
        panel.onDecision = { [weak self] session, approved in
            guard let self else { return }
            self.post("/api/chat/approve", ["sessionId": session, "approved": approved])
            // Read back rather than assume: the decision is only made when the
            // server says it was, and a panel that clears itself on the press
            // would look successful whether or not it worked.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.refresh() }
        }
        panel.show(latest)
        panel.orderFrontRegardless()
        board = panel

        /**
         * The one moment worth paying for a fresh allowance figure.
         *
         * Opening the dashboard is somebody looking at it. The server declines
         * unless the number is over an hour old, so this costs nothing most of
         * the time and about two cents when it does not — and an idle machine
         * never pays to keep a figure fresh that nobody is reading.
         *
         * The answer arrives after this returns. The panel polls, so it fills
         * in a few seconds later rather than making anyone wait for it.
         */
        post("/api/usage/refresh", ["staleMinutes": 60])
    }

    @objc private func toggleCoreMotion() {
        stillCore.toggle()
        strip?.setCoreStill(stillCore)
        // 核はレールにもいる。設定は置き場所ではなく、動くものに効く。
        rail?.setCoreStill(stillCore)
    }

    /**
     * 右辺のレールを開け閉めする。
     *
     * 帯とは別に持つ。帯は文章で、レールは数字 — 片方だけ出したい場面がある。
     * 開いた状態は覚えておく、閉じたままなら次も出さない。
     */
    /**
     * レールの頭に出すもの。形が `.rail` のときだけ。
     *
     * 帯と同じものを両方に出すと、片方が古くなったときに見分けがつかない。
     * 帯が出ているあいだ、頭は空にしておく。
     */
    private func railHead(for snapshot: Snapshot) -> RailHead? {
        guard HudShape.current == .rail else { return nil }
        guard case let .ready(all) = snapshot else {
            // 届かない往復でも、空模様は消さない。**消えるのは古くなったとき。**
            return RailHead(
                sky: lastSky, working: false, detail: [], plans: [], nextPlan: nil
            )
        }
        let events = plans(all.events)
        let sky = Sky(all.weather?.text)
        if !sky.isEmpty { lastSky = sky }
        return RailHead(
            sky: sky.isEmpty ? lastSky : sky,
            working: all.runs.contains { $0.state == "running" },
            detail: weatherDetail(all.weather),
            plans: events.isEmpty ? ["この先の予定はありません。"] : events.map { $0.line },
            nextPlan: events.first?.clock
        )
    }

    /**
     * この先の予定、数件。
     *
     * 終日の予定も出す。**時刻が無いことは、予定が無いことではない。**帯は
     * 終日を落としていたが、あれは「次に居るべき場所と時刻」を一行で言う
     * ためで、押して開く一覧に同じ理由は無い。
     */
    private func plans(_ events: [CalendarEvent]) -> [(clock: String, line: String)] {
        let calendar = Foundation.Calendar.current
        let now = Date()
        let dawn = calendar.startOfDay(for: now)
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm"
        let short = DateFormatter()
        short.dateFormat = "M/d"

        return events
            .compactMap { event -> (Date, CalendarEvent)? in
                eventDate(event.start).map { ($0, event) }
            }
            // 終日は今日のぶんから。時刻のあるものは、もう過ぎたら出さない。
            .filter { $0.1.allDay ? $0.0 >= dawn : $0.0 >= now }
            .sorted { $0.0 < $1.0 }
            .prefix(6)
            .map { date, event in
                let day = calendar.isDateInToday(date) ? "今日" : short.string(from: date)
                if event.allDay {
                    return (clock: "終日", line: "\(day)  終日  \(event.title)")
                }
                let time = clock.string(from: date)
                /*
                 * 終わりも出す。**「何時に空くのか」は始まりからは分からない。**
                 *
                 * 同じ日の中で終わるものだけ `08:30-10:40` の形にする。日を
                 * またぐものを `08:30-01:40` と書くと、**その日のうちに終わる
                 * ように読める。**またぐものは始まりだけにして、札の一行に
                 * 嘘を混ぜない。
                 */
                let span: String = {
                    guard let end = event.end, end.count >= 16, event.start.count >= 16 else { return time }
                    guard end.prefix(10) == event.start.prefix(10) else { return time }
                    return "\(time)-\(end.dropFirst(11).prefix(5))"
                }()
                return (clock: time, line: "\(day)  \(span)  \(event.title)")
            }
    }


    /**
     * 天気の札に出す文。
     *
     * ☁ と 27° は要約で、元の一文には「時々晴れ」も「夕方から」も入っている。
     * そして**いつ読んだ値なのかは、要約からは絶対に分からない。**位置情報の
     * 取得はよく失敗する場所なので、保存してあった値を出しているのか、
     * さっき取りに行った結果なのかは、聞かれたら答えられなければならない。
     */
    private func weatherDetail(_ weather: Weather?) -> [String] {
        guard let weather else { return ["IRIS に届いていません。"] }
        var lines: [String] = []
        if let text = weather.text, !text.isEmpty {
            lines.append(text)
        } else {
            lines.append("天気を取得できませんでした。")
        }
        if let reason = weather.reason, !reason.isEmpty { lines.append(reason) }

        /**
         * 何分前か。時刻ではなく。
         *
         * `23:53 に読みました` は、読んだ人が今の時刻を覚えていて引き算を
         * するという前提の書き方だった。知りたいのは**どれだけ古いか**で、
         * 時刻はその材料でしかない。
         */
        if weather.stale == true {
            let age = weather.ageMinutes ?? 0
            lines.append("最終更新 \(ago(age))。いまの空模様ではありません。")
        } else if let at = weather.at, let minutes = minutesSince(at) {
            lines.append("最終更新 \(ago(minutes))")
        }
        return lines
    }

    private func ago(_ minutes: Int) -> String {
        if minutes < 1 { return "たった今" }
        if minutes < 60 { return "\(minutes) 分前" }
        return "\(minutes / 60) 時間前"
    }

    /// ISO8601 から、いま何分前か。読めなければ何も言わない。
    private func minutesSince(_ iso: String) -> Int? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? {
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: iso)
        }()
        guard let date else { return nil }
        return max(0, Int(Date().timeIntervalSince(date) / 60))
    }


    /**
     * 帯・ノッチ・レールを行き来する。
     *
     * どれが良いかは screenshot を見比べても決まらない。切り替えて何日か
     * 使ってみるためのもので、選んだ形は覚えておく。
     */
    /**
     * 目盛りだけ取り直す。
     *
     * 全体の更新と分けてある。Claude の割合は端末のステータス行が置いていく
     * もので、こちらから催促できない — 押しても変わらないことはあるが、
     * **変わらなかったことが分かるのも読み**なので、押せる方がいい。
     */
    private func refreshUsage() {
        trace("rail reload")
        rail?.beginReload()
        reloading = true
        if case let .ready(all) = latest { reloadFrom = all.usage?.claudeLimits?.ageMinutes }
        post("/api/usage/cli/refresh", [:])
        /**
         * 何度か様子を見る。
         *
         * Claude の値だけは一回走らせないと分からず、それに十数秒かかる。
         * 一度読んで終わりにすると、**走り終わる前の古い値を見て「変わらな
         * かった」と結論する。**
         */
        for delay in [3.0, 8.0, 15.0, 25.0, 40.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.rail != nil else { return }
                self.refresh()
                if delay >= 40 { self.finishReload(force: true) }
            }
        }
    }

    /// 新しい値が来たか、待ちきったか。**黙って回り続けさせない。**
    private func finishReload(force: Bool) {
        guard reloading else { return }
        // 待ちきったら、何が読めていようと止める。**回り続けるより、
        // 変わらなかったことが分かる方がいい。**
        if force {
            reloading = false
            reloadFrom = nil
            rail?.endReload()
            return
        }
        // 比べる相手が無いなら、比べようがない。回し続ける理由にはならない
        // ので、読めた時点で止める。
        guard case let .ready(all) = latest else { return }
        let now = all.usage?.claudeLimits?.ageMinutes
        guard let was = reloadFrom else {
            reloading = false
            rail?.endReload()
            return
        }
        if let now, now < was {
            reloading = false
            reloadFrom = nil
            rail?.endReload()
        }
    }

    @objc func cycleShape() {
        HudShape.set(HudShape.current.next)
        applyShape()
    }

    /// いまの形に合わせて、出すものを出し、引っ込めるものを引っ込める。
    private func applyShape() {
        switch HudShape.current {
        case .notch:
            if strip != nil { closeStrip() }
            if notch == nil {
                let panel = Notch()
                panel.onPress = { [weak self] in self?.toggleBoard() }
                notch = panel
            }
            notch?.show(latest)
        case .rail:
            if strip != nil { closeStrip() }
            notch?.orderOut(nil)
            notch = nil
            if rail == nil { toggleRail() }
        }
        // 頭は形で決まるので、形が変わったら描き直す。
        if case .ready(let all) = latest {
            rail?.show(
                railEntries(from: all.usage),
                head: railHead(for: latest),
                loading: all.usage == nil && !everReadUsage
            )
        } else {
            rail?.show(railEntries(from: nil), head: railHead(for: latest), loading: !everRead)
        }
    }

    /// 帯を畳む。覆っている高さの申告も取り消す — 黙って消えると隙間が残る。
    private func closeStrip() {
        strip?.orderOut(nil)
        strip = nil
        coverReport?.invalidate()
        coverReport = nil
        post("/api/hud/strip", ["height": 0])
    }

    @objc func toggleRail() {
        if let existing = rail {
            existing.hide()
            rail = nil
            railVisible = false
            return
        }
        let panel = Rail()
        panel.onHead = { [weak self] in self?.openIris() }
        panel.onReload = { [weak self] in self?.refreshUsage() }
        panel.onBoard = { [weak self] in self?.toggleBoard() }
        /**
         * 走っているものがあれば前に出す。無ければ開く。
         *
         * 盤の行と同じ扱い。**開いているアプリの二枚目を作らない。**
         */
        panel.onOpenApp = { path in
            let url = URL(fileURLWithPath: path)
            if let identifier = Bundle(url: url)?.bundleIdentifier,
               let running = NSRunningApplication
                   .runningApplications(withBundleIdentifier: identifier).first {
                running.activate(options: [.activateAllWindows])
                return
            }
            guard FileManager.default.fileExists(atPath: path) else { return }
            NSWorkspace.shared.openApplication(at: url, configuration: .init())
        }
        rail = panel
        railVisible = true
        /*
         * 開いたら取り直す。
         *
         * 割合は分単位で動くのに、取り直しは三十分おきの巡回にしか繋がって
         * いなかった。**レールを開くのは、その数字を見たい瞬間そのもの**で、
         * そこで最大三十分前の数字を出していた。開いた側が古い数字を掴むのは、
         * 目盛りとしていちばんまずい形。
         *
         * `refreshUsage` を通すので、輪の再読み込みの表示もそのまま出る —
         * 走っているあいだ「取りに行っている」ことが見える。
         */
        refreshUsage()
        let head = railHead(for: latest)
        if case .ready(let all) = latest {
            panel.show(railEntries(from: all.usage), head: head)
        } else {
            panel.show(railEntries(from: nil), head: head, loading: !everRead)
        }
    }

    /**
     * 帯を出す道は残っていない。
     *
     * `⌥⌘B` と献立の項目があって、**畳んだはずのものが押せば戻った**
     * — 利用者いわく「完全に出ないようにして」。戻せる形で残っているものは、
     * 事故で戻る。`Strip` の実装はファイルに残してあるが、呼び出しは無い。
     */
    @objc func toggleStrip() {
        if strip != nil {
            closeStrip()
            stripVisible = false
        } else {
            openStrip()
            stripVisible = true
        }
    }
    /**
     * A terminal with `claude` in it, and nothing typed for them.
     *
     * The refresh needs one exchange in a real session — the payload carries
     * no limits until the first API round trip — and that exchange is theirs
     * to make. Sending a prompt on their behalf would spend their allowance
     * without asking, which is the one thing a meter must never do.
     */
    @objc private func refreshAllowance() {
        // Zero staleness: the menu item means "now", and the person choosing
        // it has decided the two cents are worth it.
        post("/api/usage/refresh", ["staleMinutes": 0])
    }

    @objc private func quit() { NSApp.terminate(nil) }
}


/**
 * 終わった作業を、**押されるまで覚えておく。**
 *
 * 一覧は `live == true` だけを出していたので、席を外しているあいだに終わった
 * 作業は**見られないまま消えていた。**終わったことこそ、次に何をするかを
 * 決める材料なのに。
 *
 * **盤の外に置いてある。**最初は盤の中に書いたが、盤はダッシュボードを開いた
 * ときに作られて閉じると捨てられるので、**見ていないあいだの終了はそもそも
 * 記録されなかった。**巡回のたび、盤が開いているかに関わらず突き合わせる。
 *
 * **Claude だけ。**Claude の `live` はプロセスが生きているかの実測だが、
 * Codex のそれは「最後の活動から2分以内か」という推測で、**人が少し考えて
 * いるだけで false になる。**そこに「終了しました」と書けば、動いているものを
 * 終わったことにする。推測の上に断定を積まない。
 *
 * 「完了」でも「中断」でもなく「終了」なのは、**こちらに区別が付かないから。**
 * 分かるのは、動いていたものが動いていない、それだけ。
 *
 * 開いたら消える。七日置いて誰も開かなかったものも消える。
 */
final class EndedLedger {
    static let shared = EndedLedger()

    struct Ended: Codable {
        let id: String
        let title: String
        let endedAt: Date
        let resume: String?
    }

    /**
     * 生きているのを最後に見た時刻を持つ。
     *
     * 持たないと、**HUD が落ちているあいだに終わったものが「今 終了」になる。**
     * 気づいた時刻を、終わった時刻として書いてしまう。分かるのは「最後に
     * 見えていたのはここまで」だけなので、それを終わりとして扱う。
     */
    struct Seen: Codable {
        let title: String
        let resume: String?
        let at: Date
    }

    private static let endedKey = "board.ended"
    private static let liveSeenKey = "board.liveSeen"
    private var liveSeen: [String: Seen] = [:]
    private(set) var rows: [Ended] = []

    private init() {
        let store = UserDefaults.standard
        if let raw = store.data(forKey: Self.endedKey),
           let decoded = try? JSONDecoder().decode([Ended].self, from: raw) {
            rows = decoded
        }
        if let raw = store.data(forKey: Self.liveSeenKey),
           let decoded = try? JSONDecoder().decode([String: Seen].self, from: raw) {
            liveSeen = decoded
        }
    }

    private func save() {
        let store = UserDefaults.standard
        store.set(try? JSONEncoder().encode(rows), forKey: Self.endedKey)
        store.set(try? JSONEncoder().encode(liveSeen), forKey: Self.liveSeenKey)
    }

    /// 巡回のたびに突き合わせる。描画とは無関係に走る。
    func note(_ sessions: [Session]) {
        let now = Date()
        var live: [String: Seen] = [:]
        for session in sessions where session.live == true && session.kind != "codex" {
            guard let work = session.work, !work.isEmpty else { continue }
            live[session.id] = Seen(title: work, resume: session.resume, at: now)
        }

        // 見えていたのに居なくなったもの。すでに控えてあるものは重ねない。
        let known = Set(rows.map { $0.id })
        for (id, seen) in liveSeen where live[id] == nil && !known.contains(id) {
            // 終わった時刻は**最後に見えていた時刻**。気づいた時刻ではない。
            rows.append(Ended(id: id, title: seen.title, endedAt: seen.at, resume: seen.resume))
        }
        // もう一度動き出したものは、終わっていない。
        rows.removeAll { live[$0.id] != nil }

        let week = now.addingTimeInterval(-7 * 86_400)
        rows.removeAll { $0.endedAt < week || $0.title.isEmpty }

        liveSeen = live
        save()
    }

    /// 押された行を控えから外す。**見たものは、もう出さない。**
    func forget(_ id: String) {
        rows.removeAll { $0.id == id }
        save()
    }

    /**
     * 終わったものを、まとめて外す。
     *
     * 一件ずつ押すのが大変だ、と（利用者、2026-09-08）。**終わった行は
     * 一件ずつ増えるが、片付けたい気持ちはまとめて起きる。**評価の空実行の
     * ように一晩で369件並ぶことがあるので、一件ずつでは追いつかない。
     *
     * 消えるのは**終わった控えだけ**で、動いているものには触らない
     * （`rows` は終わったものしか持たない）。控えは盤の外にあり、消しても
     * セッションそのものは残る —— 消えるのは「まだ見ていない」という印。
     */
    func forgetAll() {
        rows.removeAll()
        save()
    }
}

/**
 * IRIS の URL を、IRIS の窓で開く。
 *
 * `NSWorkspace.open(url)` は既定のブラウザに新しいタブを開く。IRIS の
 * web アプリが既に動いていても、そちらには行かない（「押したら新しく
 * ブラウザ開いちゃう」— 利用者、2026-09-11）。インストール済みの web
 * アプリがあればそこへ渡し、無ければ従来どおりブラウザへ。
 *
 * web アプリは Safari の「Web App」で、URL を渡せば自分の範囲内なら
 * その窓で開く。実測 2026-09-11：`open -a IRIS.app <url>` で動いている
 * Web App プロセスに届いた。
 */
func openInIris(_ url: URL) {
    let installed = URL(fileURLWithPath: NSHomeDirectory() + "/Applications/IRIS.app")
    guard FileManager.default.fileExists(atPath: installed.path) else {
        NSWorkspace.shared.open(url)
        return
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.open([url], withApplicationAt: installed, configuration: configuration) { _, error in
        // 渡せなかったときだけブラウザへ。**開いたふりはしない。**
        if error != nil { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
    }
}

