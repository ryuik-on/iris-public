import Foundation
import UserNotifications

/**
 * IRIS の側から声をかける。
 *
 * 先回りの規則は前から発火していた。**届く先が無かった。**提案は
 * `/api/proactive` の `pending` に積まれ、画面と盤が**取りに行く**だけで、
 * 押し出す口が一本も無かった —— だから見に行かないかぎり何も知らされない。
 * 期限を13日過ぎた課題が黙っていたのも、当日の課題が黙っていたのも、
 * 条件を直したあとは「発火はしている、届いていない」だった。
 *
 * ここが押し出す側。盤は常駐していて身元（`com.user.iris.hud`）を持つので、
 * macOS の通知がそのまま使える —— **はずだった。**
 *
 * ## この機械では通らない（実測 2026-09-30）
 *
 * `requestAuthorization` は確認を出さずに即
 * 「Notifications are not allowed for this application」を返す。**拒否された
 * のではなく、問い合わせること自体が通っていない。**
 *
 * 切り分けた結果：
 *
 *   - LaunchServices には登録されている（`lsregister -dump` に出る）
 *   - 署名は valid、`Info.plist` は `APPL`＋バンドルID、隔離属性も無い
 *   - **同じ作り方の最小のアプリ**（別のバンドルID、ad-hoc 署名）では応答すら
 *     返らない —— つまり盤の作りの問題ではない
 *   - `osascript` の `display notification` も届かない。`com.apple.ncprefs` に
 *     Script Editor も含めて**一つも登録が無い**
 *
 * **手元で署名したアプリに通知の許可が下りない機械**か、通知そのものが
 * 止められている。どちらにせよ、ここを直しても届かない。
 *
 * この道を捨てずに残してあるのは、**確かめた事実がここにしか無い**から。
 * 許可が下りる機械に移せば、このまま動く。届ける先を変えるなら、
 * `deliver` を呼んでいる側（`IrisMenuBar.swift` の `refresh`）を差し替える。
 *
 * ## 同じことを二度言わない
 *
 * 提案には id がある。出したものを覚えておき、**同じ id では二度鳴らさない。**
 * 覚えるのは `UserDefaults` —— 盤を入れ替えただけで、昨日見た報せがもう一度
 * 出るのは、報せそのものへの信用を削る。
 *
 * ## 何を言うか
 *
 * 表題は規則の文、本文は**その根拠の中身。**「期限が迫っている課題があります」
 * だけでは、開くまで何も分からない。**件数では動けない**のは通知でも同じで、
 * T011 が13日超過だと書いてあれば、開かずに判断できることがある。
 */
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  /// 出したことのある提案の id。
  private var delivered: Set<String>
  private let defaultsKey = "iris.notified.ids"
  /// 許可を求めたか。**一度だけ聞く。**断られたら黙る。
  private var asked = false
  private var allowed = false
  /// 通知が押されたときに開くもの。
  private let onOpen: () -> Void

  init(onOpen: @escaping () -> Void) {
    self.onOpen = onOpen
    let stored = UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
    self.delivered = Set(stored)
    super.init()
    UNUserNotificationCenter.current().delegate = self
  }

  /**
   * 許可を一度だけ求める。
   *
   * 起動のたびに聞くと、断った人に毎回聞くことになる。結果は OS が覚えている
   * ので、こちらは**聞いたかどうか**だけを覚えればいい。
   */
  private func ensureAllowed(_ then: @escaping (Bool) -> Void) {
    if asked { then(allowed); return }
    asked = true
    trace("notify: asking for permission")
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
      [weak self] granted, error in
      trace("notify: permission answered granted=\(granted) error=\(error?.localizedDescription ?? "none")")
      if let error {
        NSLog("IRIS: 通知の許可を取れませんでした: %@", error.localizedDescription)
      }
      self?.allowed = granted
      DispatchQueue.main.async { then(granted) }
    }
  }

  /**
   * まだ出していない提案を出す。
   *
   * 溜まっていたものを一度に並べない。**起動直後に五つ鳴るのは、五つとも
   * 読まれない。**新しい順に三つまでにして、残りは盤で見てもらう。
   */
  func deliver(_ pending: [Suggestion]) {
    // id の無い提案は追えないので出さない。**二度言わない保証が付けられない。**
    trace("notify: pending=\(pending.count) delivered=\(delivered.count)")
    let fresh = pending.filter { item in
      guard let id = item.id else { return false }
      return !delivered.contains(id)
    }
    guard !fresh.isEmpty else { return }
    trace("notify: fresh=\(fresh.count)")
    ensureAllowed { [weak self] granted in
      trace("notify: granted=\(granted)")
      guard let self, granted else { return }
      for item in fresh.suffix(3) {
        self.post(item)
      }
      // 出さなかったぶんも「出した」と印を付ける。**あとから遡って鳴らさない。**
      for item in fresh { if let id = item.id { self.delivered.insert(id) } }
      // 際限なく覚えない。直近 200 件で足りる。
      let kept = Array(self.delivered).suffix(200)
      self.delivered = Set(kept)
      UserDefaults.standard.set(Array(kept), forKey: self.defaultsKey)
    }
  }

  private func post(_ item: Suggestion) {
    guard let id = item.id else { return }
    let content = UNMutableNotificationContent()
    content.title = item.suggestion ?? "IRIS"
    // 根拠の中身。**開かずに判断できることがある。**
    let detail = item.because?.flatMap { $0.valueLines }.prefix(3).joined(separator: "\n") ?? ""
    content.body = detail
    content.sound = .default
    let request = UNNotificationRequest(
      identifier: id,
      content: content,
      // すぐ出す。予約ではない。
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request) { error in
      trace("notify: posted \(id) error=\(error?.localizedDescription ?? "none")")
      if let error {
        NSLog("IRIS: 通知を出せませんでした: %@", error.localizedDescription)
      }
    }
  }

  /// 押されたら盤を開く。**報せを読んで、次に何を見るかまでを一続きにする。**
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    DispatchQueue.main.async { [weak self] in self?.onOpen() }
    completionHandler()
  }

  /// 盤が前面にいても出す。常駐なので「前面」は珍しくない。
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}
