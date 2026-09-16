import { FutureFeatureInput } from '../services/future_features_sqlite.js';

/**
 * The register's initial contents.
 *
 * Sourced from the v4 handoff and the supplementary Future Work handoff, so
 * that "what is deferred and why" stops depending on chat history and human
 * memory (§30). Seeding is idempotent by `key`, and re-seeding never drags an
 * entry's status back to its documented default once it has been moved.
 *
 * Three axes are kept apart on purpose (§28/§29):
 *   status       — what we intend to do
 *   verification — how far it has actually been verified
 *   reality      — whether it exists in this repository right now
 *
 * `reality` values are recorded from the audits described in the handoffs, not
 * assumed. Anything claimed as implemented but absent at audit is
 * REPORTED_BUT_NOT_FOUND, and must be re-checked before it is trusted (§32).
 */

const V4 = 'HANDOFF v4';
const SUPP = 'Future Work 追加ハンドオフ';
const AMBIENT = 'Ambient AI ロードマップ（2026-08-19 合意）';
const AUDIT = 'レジスタ現実監査（2026-08-19）';

export const FUTURE_FEATURE_SEED: FutureFeatureInput[] = [
  // ------------------------------------------------------------------ done
  {
    key: 'reliable_state',
    title: 'Reliable State（会話・承認の永続化）',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason: 'v4 の P0。受け入れ条件をすべて満たし、実機で再起動・リロードを検証済み。',
    evidence: ['commit 771f7b0', 'scripts/test-reliable-state.ts', 'launchd 再起動で状態保持を確認'],
    source: `${V4} §9`,
  },
  {
    key: 'production_tools',
    title: '本番ツール登録（ワークスペース封じ込め付き）',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason: '承認境界に実トラフィックを通すため。実 Gemini で承認・拒否・再送の全経路を検証済み。',
    evidence: ['commit f72aeab', 'scripts/probe-boundary.ts で実 .env への到達を10件すべて遮断'],
    source: `${V4} §5`,
  },
  {
    key: 'resilience_timeouts',
    title: 'タイムアウト・リスク別リトライ・実行期限',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason:
      'Overnight Mode の前提。副作用のあるツールはタイムアウト時に「不明」と報告し、決して自動再実行しない。',
    evidence: ['commit a099856', '50ms 予算を強制した実インスタンスで 0.47 秒の明示失敗を確認'],
    source: `${V4} §47`,
  },
  {
    key: 'development_task_handoff',
    title: 'Development Task / 正準ハンドオフ / 結果取得',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason: '§83 の最小フロー。手作業のコンテキスト再構成を、貼り付け可能な1ブロックで置き換える。',
    evidence: ['commit 7bd3323', '実サーバでタスク作成→決定記録→run→heartbeat→ハンドオフ生成を確認'],
    source: `${V4} §83`,
  },
  {
    key: 'activity_log',
    title: 'Activity / System Log',
    domain: 'observability',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'v4 §4 では activity_logs が REPORTED_BUT_NOT_FOUND だったが、Reliable State で実際に実装した。エラーを会話履歴から隔離する土台。',
    evidence: ['migration 3', 'commit 771f7b0'],
    source: `${V4} §4, P1-9`,
    notes: '過去の「報告のみ」から、実在する実装へ移行した項目。',
  },
  {
    key: 'launchd_service',
    title: 'launchd 常駐',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason: '登録済みで、再起動による状態保持も実測済み。',
    resumeCondition: 'ログアウト／再起動をまたいだ復帰の検証が未実施。',
    evidence: ['scripts/install-launchd.sh', 'kickstart で PID 変更と状態保持を確認'],
    source: `${SUPP} §28`,
    notes:
      '監査(2026-08-19): com.user.iris として稼働中。同日、実行体を保護フォルダ外へ移し、npm start + ビルド済みクライアント、ログ世代交代、KeepAlive の限定に是正した。' + 'Sleep/Wake・ログアウト復帰は未検証。Production Mode 移行は別項目。',
  },
  {
    key: 'future_feature_register',
    title: 'Future Feature Register',
    domain: 'development_acceleration',
    status: 'CURRENT',
    verification: 'IMPLEMENTED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason: '将来機能をチャット履歴と人間の記憶だけで管理する状態から脱却するため。',
    source: `${SUPP} §30`,
    evidence: [
      'server/services/future_features_sqlite.ts',
      'server/core/future_features_service.ts',
      'server/tools/register.ts',
      'scripts/test-register.ts',
    ],
  },

  // -------------------------------------------------- development acceleration
  {
    key: 'coding_agent_invocation',
    title: 'コーディングエージェントの起動（LEVEL 2）',
    domain: 'development',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '利用者が 2026-08-20 に明示的に採用を決定。ただし当初想定した「IRIS の推定で起動する」形ではなく、' +
      '利用者が起きている間に予約した行を後から読み出す形にした。起点が利用者の明示指示のままなので、' +
      '承認境界に例外を作らずに無人運転が成立する。',
    resumeCondition:
      '実際にエージェントを起動したことがまだ一度もない。予約・一覧・取消と拒否判定は実機で確認したが、' +
      'spawn から停止までの経路は未実行。初回は起きている時刻に予約して、費用計測と停止が効くかを見ること。',
    dependencies: ['development_task_handoff'],
    evidence: [
      'server/core/agent_runner.ts',
      'server/services/agent_meter.ts',
      'server/services/agent_process.ts',
      'server/services/agent_schedule_sqlite.ts',
      'scripts/test-agent-runner.ts（57件）',
      'scripts/test-agent-schedule.ts（32件）',
      'db.ts migration 17',
      '実機: POST/GET/DELETE /api/agent/schedule の往復を確認',
      '2026-08-22 実測: Codex は作業ツリーでコミットできなかった。' +
        "fatal: Unable to create '<repo>/.git/worktrees/<id>/index.lock': Operation not permitted",
      '2026-08-22 実測: --add-dir に共有 git ディレクトリを渡すとコミットが通る（[agent/… c1da63c]）',
      "2026-08-22 実測: 同じ実行内で git push は fatal: transport 'https' not allowed のまま",
    ],
    source: `${V4} §77 LEVEL 2`,
    risk:
      '任意コマンド実行はワークスペース封じ込めを事実上迂回しうる。\n\n' +
      'もう一つの危険が実際に起きた。2026-08-21 に「作業ツリーで git add と git commit は両方成功する」と実測したと' +
      'コードのコメントに書いたが、それは誤りだった。Codex の workspace-write は作業ディレクトリの中しか書けず、' +
      '作業ツリーの git ディレクトリは親リポジトリ側にあるため、コミットは常に外へ書こうとして失敗する。' +
      '委任した4回が連続で「編集はしたがコミットしていない」状態で終わり、その間コメントは「問題ない」と説明し続けた。' +
      '誤った実測記録は、実測していないことより悪い。',
    notes:
      '境界は限定した。許可リポジトリは完全一致の4件（前方一致でもワイルドカードでもない）。' +
      '環境変数は継承せず PATH/HOME/LANG/TERM だけを組み立てて渡す — IRIS のプロセスには4プロバイダの API キーと ' +
      'iCloud のアプリパスワードが載っており、素の spawn は全部渡してしまい、しかも正常に動くため気づけない。' +
      'argv は固定形（-p / --permission-mode acceptEdits / --output-format json）で、呼び出し側が渡すのはタスクIDとリポジトリだけ。' +
      'push は --disallowedTools "Bash(git push*)" "Bash(gh *)" で CLI 側から塞ぐ。作業は agent/<runId> ブランチ、作業ツリーが汚れていれば実行しない。' +
      '費用は起動先の転記(~/.claude/projects/.../\*.jsonl)からトークンを実測して換算する — IRIS の支出上限は別プロセスには効かないため。' +
      '転記が読めなくなったら上限が効かない状態になるので、3分の猶予後に停止する。' +
      '当初 --handoff というフラグを仮定して実装しかけたが実在せず、claude --help を読んで判明した（テストは全て緑のままだった）。' +
      '「IRIS の推定で起動する」案は standing_authorization として実装まで進めたが、' +
      '同じ目的が境界に触れずに達成できると分かったため削除した。設計の経緯は ' +
      '/api/decisions?affecting=coding_agent_invocation を参照。',
  },
  {
    key: 'independent_review_second_model',
    title: '別モデルによる独立レビュー（LEVEL 3）',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'ハンドオフの review ロールと結果スキーマは実装済みだが、設定されている API キーが GEMINI のみのため、実際に独立したレビューにならない。',
    resumeCondition: 'ANTHROPIC_API_KEY または OPENAI_API_KEY が設定された時点。',
    dependencies: ['development_task_handoff'],
    evidence: ['server/core/handoff.ts の review ロールと結果スキーマは実装済み'],
    source: `${V4} §62, §10`,
    notes: '同期(2026-08-19): DB 側が先行していた。claude-sonnet-5 / claude-opus-5 / gpt-5.6-terra で独立レビューが成立している。seed が古かったので実態に合わせた。',
  },
  {
    key: 'openai_provider',
    title: 'OpenAI プロバイダ実装',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason: 'ユーザーの実ワークフローが Claude → GPT のため、独立レビューの前提となる。',
    resumeCondition: 'OPENAI_API_KEY の設定と、継続的コストの了承。',
    dependencies: ['independent_review_second_model'],
    source: `${V4} §11`,
    notes: '監査(2026-08-19): server/providers/openai.ts が存在し、ルーティング順 gemini>anthropic>openai の一員として稼働。gpt-5.6-terra で独立レビューも成立。PLANNED/NOT_IMPLEMENTED は誤りだった。',
    evidence: [
      'server/providers/openai.ts',
      'scripts/test-provider-errors.ts',
    ],
  },
  {
    key: 'development_telemetry',
    title: '開発テレメトリ（モデル別の実績蓄積）',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'activity_logs とオーケストレータのイベントで下地はあるが、タスク種別ごとのモデル成績としてはまだ集計していない。',
    dependencies: ['activity_log'],
    source: `${V4} §12`,
    evidence: [
      'server/core/telemetry_service.ts',
      'scripts/test-telemetry.ts（33件）',
      '/api/telemetry/models, /api/telemetry/compare',
    ],
    notes:
      '新しい記録は一切増やしていない。agent_runs（結果）と activity_logs の run.usage（費用）を' +
      '読むだけ。二つ目の記録経路は、一つ目と食い違いうる二つ目の何かでしかない。' +
      '中心はランク付けの拒否で、試行5件未満は insufficient として比較に使わせない — ' +
      '試行2件の50%を試行40件の隣に並べた表は、支えられない判断を誘う。' +
      '費用は呼び出し単価ではなく成功1件あたりで出す。半額でも3回失敗するモデルは安くない。' +
      '成功0件のモデルには成功単価を出さない（無限大の費用を報告することになるため）。' +
      '実行中の run は集計から除く。遅いことを間違いとして数えないため。'
  },
  {
    key: 'shell_command_tool',
    title: 'シェル / コマンド実行ツール',
    domain: 'action_layer',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      '本番ツール登録時に意図的に除外した。承認必須にしても、任意コマンドは実質的にすべての境界を迂回する（cat .env が書けてしまう）。',
    resumeCondition: '許可コマンドの限定方式をユーザーが決定した時点。',
    risk: 'ワークスペース封じ込め・機密拒否リストの両方を無効化しうる。',
    source: `${V4} §11.6`,
    notes:
      '見送り(2026-08-20、利用者の判断)。コマンド実行の需要は coding_agent_invocation で境界つきに満たされた — ' +
      '呼び出し側はタスクIDとリポジトリだけを渡し、argv はサーバ側で固定形に組み立てる。' +
      'コマンド文字列を受け取らないことで任意コマンド実行にならない、というのが再開条件にあった「限定方式」の実例。' +
      '汎用シェルを足すと同じ能力に2本目の弱い経路ができ、手軽な方が使われる。' +
      '小さな用途が出てきた場合は、汎用シェルではなく用途ごとの名前つきツール（run_tests など、引数は列挙値）にすること。'
  },

  {
    key: 'gemini_schema_conversion',
    title: 'Gemini へのツールスキーマ変換',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason:
      'Gemini は OpenAPI の部分集合しか受け付けず、知らないキーが1つあるとリクエスト全体を 400 で拒否する。' +
      '外部（MCP）由来のスキーマを無変換で渡していたため、カレンダー MCP が繋がっている間は' +
      'IRIS がどのメッセージにも応答できなかった。壊れるのは該当ツールではなく会話そのもの。',
    dependencies: ['universal_action_layer_mcp'],
    evidence: [
      'server/providers/gemini_schema.ts',
      'scripts/test-gemini-schema.ts',
      'scripts/fixtures/mcp-calendar-schemas.json',
      '実機で 9 ツール中 6 件が縮約され、変換不能 0 件。修正前は同じ入力で 400（2026-08-20）',
    ],
    source: '2026-08-20 の実機検証で発見',
    notes:
      '除去リストではなく許可リストで実装した。エラーが名指しした4キー（$ref / $defs / deprecated / ' +
      'x-google-enum-descriptions）だけを消す実装はその日は通り、次に別のキーを出すサーバが来た時点で同じ形で破れる。' +
      '変換できないツールは黙って落とさず名指しでログに出す（gemini.tools_skipped）。' +
      'ユニットテストは緑のまま実機で初めて壊れた事例で、発見も life_state の実機検証の副産物。',
  },

  {
    key: 'runtime_health_visibility',
    title: '稼働中の連携が答えられるかを health が見る',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '/api/health は 2026-08-19 13:00 〜 08-20 16:16 の31時間、Google 経路が全滅している間ずっと healthy を返していた。' +
      'orchestrator の有無と DB のスキーマ版しか見ておらず、configIssues は起動時に一度計算した定数だった。' +
      'NEXT.md が次のセッションに最初に走らせろと書いているコマンドが、31時間「異常なし」と答え続けた。',
    resumeCondition:
      'degraded 側は実機で未観測。動いている資格情報を壊す以外に再現手段がないため見送った。' +
      'OAuth クライアントが External + Testing なら 2026-08-27 01:16 JST 前後にリフレッシュが失効するので、' +
      'そのとき health が自力で degraded になれば実機で確認できる。',
    dependencies: ['google_calendar'],
    evidence: [
      'server/core/integration_health.ts',
      'scripts/test-integration-health.ts（27件、当日の状態を再現して degraded を確認）',
      '実機: integrations に google/icloud/mcp が ready として出ることを確認',
    ],
    source: '2026-08-20 の障害調査で発見',
    notes:
      '状態を4つに分けたのが設計の中身: not_configured（未設定は選択であって障害ではない）/ ready（応答した積極的な証拠）/ ' +
      'failing（設定済みなのに応答できない — これだけが degraded にする）/ unknown（設定済みだが安価に確認できない、名指しで報告）。' +
      '未設定で赤くなる health は読まれなくなり、読まれない health は無いより悪い。' +
      '検知の要点は「黙って降りた源」を見ること。Google はエラーを出していない — トークンを失って configured() が false になり、' +
      '呼ばれなくなり、contributions に現れず、lastError も付かなかった。既存の劣化検知は全て「試して失敗した源」を見ていたため素通りした。' +
      'そのため寄与の欠落を明示的に照合する（missingFrom）。トークンの有無だけでは不十分で、認可があっても源として動いていない状態を捕まえられない。' +
      '期限切れのアクセストークンはリフレッシュトークンがあれば障害としない（毎時赤くなる health は読まれない）。',
  },

  {
    key: 'finance_csv_import',
    title: '金融 CSV の取り込み',
    domain: 'finance',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '金融データが IRIS に入る唯一の経路。スクレイピングは銀行パスワードの保持を要して PROHIBITED と両立せず、' +
      '銀行 API も個人向けには開かれていない。利用者が明細をダウンロードして置く形なら、資格情報を持たず自動操作もせずに家計を把握できる。',
    resumeCondition:
      '実ファイルでの取り込みが未実施。対応形式は3つ（日本の銀行・カード・汎用UTF-8）で、' +
      '実際の明細の見出しが一致するかは未確認。一致しなければ推測せず見出しを返して拒否するので、descriptor を1件足すことになる。',
    dependencies: ['finance_local_boundary'],
    evidence: [
      'server/core/finance_csv.ts',
      'server/services/finance_sqlite.ts',
      'scripts/test-finance.ts（62件）',
      'db.ts migration 18',
    ],
    source: '2026-08-20 の利用者の判断（fi_browser_scraping の代替として）',
    notes:
      '境界は利用者が 2026-08-20 に決定した。ファイルは ~/Library/Application Support/IRIS/finance/ に置く — ' +
      'ワークスペース外なので read_file（READ = 自動実行）からは届かず、明細が承認なしにクラウドへ渡ることがない。' +
      '個別の取引は local_only で13ヶ月後に削除、月別・カテゴリ別の集計は shareable で恒久保持。' +
      'テーブルを2つに分けたのはこのためで、1つにすると片方の規則がもう片方に押し付けられ、負けるのは厳しい側になる。' +
      '解析は推測しない。見出しが既知の descriptor に一致しなければ、見出しを引用して拒否する — ' +
      '当てずっぽうに読むと、間違った月や符号の1年分の支出が「傾向」に見えてしまい、バグに見えない。' +
      '存在しない日付(2026-02-30)は翌月に繰り上げず拒否する。入金と出金の両方に値がある行も推測せず飛ばす。' +
      '実装中、取り込みを取り消しても月次集計が古いまま残るバグをテストが捕まえた（upsert は行が0件になった分類を更新しないため）。',
  },

  {
    key: 'local_backup',
    title: 'ローカル定期バックアップ',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '2026-08-20 時点で DB の複製が2日前の手動スナップショット2件しかなく、うち1件は当時の1/20のサイズだった。' +
      'その間に入った決定・経験・レジスタの更新・金融の実装は、どこにも複製がなかった。' +
      'finance_local_boundary がクラウドを禁じているため、ローカルで取る。',
    dependencies: ['finance_local_boundary'],
    evidence: [
      'server/core/backup_retention.ts',
      'server/services/backup_service.ts',
      'scripts/test-backup.ts（28件）',
      '実機: ~/Library/Application Support/IRIS/backups に 1.3MB のスナップショットを取得し検証',
      'health の integrations に backups を追加（48時間で failing）',
    ],
    source: '2026-08-20 の利用者の判断（auto_cloud_financial_backup の代替として）',
    notes:
      'ファイルコピーではなく VACUUM INTO を使う。稼働中の DB には WAL があり、.db だけ複製すると' +
      '開けるが直近の書き込みが欠けたファイルになる — それはまさにバックアップが欲しかった理由の部分。' +
      '取得のたびに開いて integrity_check とスキーマ版を確認してから古いものを間引く。検証していないスナップショットは' +
      'ファイルについての思い込みであってバックアップではない。' +
      '保持は 日別14 / 週別1ヶ月 / 月別1年（利用者が選択）。密度を変えたのは誤りに気づく時期の分布に合わせるため — ' +
      '3月の取り込みミスに6月に気づくことがあり、日別14世代では戻れない。' +
      '間引きは暦のバケット単位で、ファイル数を数えない — 数えると毎日取れている前提になり、取れなかった日こそ何かが壊れている。' +
      '実装中に2つ捕まえた: (1) 検証を「レジスタが空なら不正」としたため、未シードの DB では毎回破棄され' +
      'バックアップが1つも残らなかった。空の表は状態であって、欠けた表が壊れたファイル。' +
      '(2) 日数をミリ秒割り算で見ていたため、14日前の03:00に取ったものが14.375日と判定されて窓から落ちた。暦日で数える。',
  },

  {
    key: 'local_data_permissions',
    title: 'ローカルデータのファイル権限',
    domain: 'safety_boundary',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'ワークスペース封じ込め・承認境界・local_only は「IRIS が何を渡すか」を決めるが、' +
      '同じマシンの別アカウントがファイルを直接開くことについては何も言わない。' +
      '2026-08-20 時点で金融明細・作業ツリー・DB 全体のコピー（local_only の明細を含む）がすべて世界読み取り可能だった。',
    dependencies: ['finance_local_boundary'],
    evidence: [
      'server/core/local_permissions.ts',
      'scripts/test-permissions.ts（24件）',
      'GET /api/permissions',
      'health の integrations に permissions を追加',
      '実機: finance / backups / worktrees を 700、jarvis_memory.db を 600 に変更',
    ],
    source: '2026-08-20、full_sandbox_migration の判断から派生',
    notes:
      'full_sandbox_migration の代替ではなく、あの意図のうちこの環境で取れる部分。' +
      '起動のたびに適用し直す — 後から作り直されたディレクトリは umask を継承するため、' +
      '一度手で締めただけでは何かが再構築された時点で静かに元へ戻る。' +
      '適用だけでなく確認もする（health の permissions プローブ）。締められなかったことが見えないと、' +
      '締めたつもりで開いている状態になる。' +
      '利用者が持ち運ぶマシンで動かしており、常駐機を別途購入予定であることも判断材料になった。',
  },

  // ------------------------------------------------------------ personal state
  {
    key: 'life_state',
    title: 'Life State / World State',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'IRIS が「今何が真か」を1つの像として組み立てる層。何も保持せず、Context Engine・記憶・時刻を' +
      'その場で読んで合成する。get_current_time はその最初の断片。',
    dependencies: ['google_calendar', 'reliable_state'],
    evidence: [
      'server/core/life_state.ts',
      'server/tools/life_state.ts',
      'scripts/test-life-state.ts',
      'GET /api/life-state（実機で実カレンダー・実記憶を返すことを確認）',
      '実機の会話でモデルが get_current_state を自発的に呼び、その結果だけで回答した（2026-08-20、Gemini 経由）',
    ],
    source: `${V4} §11.2, P2-16`,
    notes:
      '当初の reason は「保持するための中核」だった。調査の結果、合成層は既に Context Engine として存在し' +
      '（カレンダーは既にその観測源）、欠けていたのは保持ではなく会話経路への露出だった — ContextEngine の' +
      '消費者は proactive_service ただ1つで、会話中のモデルは時計と記憶しか持たなかった。' +
      'そのため独自のテーブルを持たない読み取り専用の合成層とした。新テーブルは0件で、' +
      'memory_architecture で避けた「巨大な無差別テーブル」を構造的に踏めない。判断の経緯は ' +
      '/api/decisions?affecting=life_state を参照。',
  },
  {
    key: 'project_topic_foundation',
    title: 'Project / Topic の基盤',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason: '会話をスレッドを越えて関連付けるための土台。',
    dependencies: ['reliable_state'],
    source: `${V4} P2-17`,
    evidence: [
      'server/services/topics_sqlite.ts',
      'server/core/topic_service.ts',
      'server/tools/topics.ts',
      'db.ts migration 7',
      'scripts/test-topics.ts',
    ],
    notes: '監査漏れ(2026-08-19): 実装・テスト・コミットまで済んでいたのに NOT_IMPLEMENTED のままだった。register:drift はレジスタと seed を比べるだけで、同じ誤りが両方にあると一致してしまう。この取りこぼしが register:verify（リポジトリとの照合）を作る動機になった。',
  },
  {
    key: 'memory_architecture',
    title: 'Memory / State / Knowledge の分離',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason: '巨大な無差別 Memory テーブルを作らないための境界設計。信頼度・保持期間・プライバシーが異なる。',
    dependencies: ['project_topic_foundation'],
    source: `${V4} §27, §13`,
    evidence: [
      'server/core/memory.ts（4軸と admission gate）',
      'server/services/memory_sqlite.ts（MemoryStore）',
      'db.ts migration 14（memories）',
      'scripts/test-memory.ts（37件）',
    ],
    notes:
      '【実装(2026-08-19)】境界を4軸で切った。レジスタの「信頼度・保持期間・プライバシー」に'
      + '出所を足してある — 今日の作業で、同じ文字列でも出所が違えば別物だと繰り返し分かったため。'
      + '出所(provenance): user / measured / inferred / external。'
      + '8/24は本試験（本人）、TCCは起動元に帰属する（3通り実測）、respond_to_eventは招待に返信する'
      + '（MCPサーバの説明文）— 並べて思い出すと区別がつかない。区別を保持するのは出所だけ。'
      + '信頼度は出所ごとに上限を持つ（user 1.0 / measured 0.95 / inferred 0.7 / external 0.4）。'
      + '文書に何が書いてあるかを確信することと、それが正しいと確信することは別で、'
      + '思い出された記憶が主張するのは後者だから。'
      + '保持: durable / until / session。予定は翌日には無価値、選んだ声は変更まで有効。'
      + '区別できない置き場は前者を溜め、後者を失う。'
      + 'プライバシー: shareable / local_only。判定は書き込み時ではなく取り出し時に行う。'
      + '呼ぶ側全員が覚えている前提の境界は、既にどこかで破られている。'
      + 'しかも local_only が外部プロンプトに載っても応答は正常に返るので、誰も気づかない。'
      + '矛盾しても削除しない。何を信じていて、いつ信じなくなったかは別の事実で、'
      + '後者の方が有用だった場面が今日だけで複数ある（与えられたのに無効化されたマイク許可は、'
      + '一度も与えられていないものと見分けがつかなかった）。期限切れは削除するが、否定されたものは残す。',
  },
  {
    key: 'memory_admission_gate',
    title: 'Memory Admission Gate',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '意味的に類似しているだけでは注入根拠にならない。外部テキストが無条件に個人の正典記憶になることを防ぐ。',
    dependencies: ['memory_architecture'],
    risk: '外部由来テキストのプロンプトインジェクション。',
    source: `${V4} §12, §28`,
    evidence: [
      'server/core/memory.ts の admit()',
      'scripts/test-memory.ts（37件）',
    ],
    notes:
      '【実装(2026-08-19)】外部由来のテキストは拒否せず、書き換えて受け入れる。'
      + '「Xによれば: …」の形にし、出所を内容そのものに含める。外の文章を捨てるのは惜しいことが多く、'
      + '許されないのは IRIS が自分で確かめたかのように保持することの方だから。'
      + '信頼度は 0.4 で頭打ち。高い値を自己申告しても切り下げる — 外部が自分の信頼性を主張できるなら'
      + '門番の意味がない。'
      + '門は IRIS 自身にも適用する。内部呼び出しを信用する門は、まさに外部テキストを内側へ運ぶ経路'
      + '（ツールの応答を扱う内部コード）で迂回される。'
      + '計測と申告されたが根拠が空のものは推論へ格下げする。根拠のない計測は、計測の顔をした主張で、'
      + '確定済みに読める分だけ質が悪い。',
  },
  {
    key: 'cross_thread_retrieval',
    title: 'スレッド横断の検索・文脈取得',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '「どのスレッドで言ったか」をユーザーに覚えさせないため。全会話を毎回モデルに送る解法は禁止。',
    dependencies: ['memory_architecture'],
    source: `${V4} §8.9`,
    evidence: [
      'server/services/search.ts',
      'db.ts migration 11（message_search, trigram）',
      'server/tools/topics.ts の search_conversations',
      'scripts/test-search.ts',
    ],
    notes:
      'トークナイザは実測で決めた。既定の unicode61 は日本語に語境界を見つけられず、' +
      '「気管支平滑筋を弛緩させる」の中の「平滑筋」に一致しない。trigram は3文字単位で索引するため一致する。' +
      '代償は検索語3文字以上という制約で、これは「短すぎる」として報告する — ' +
      '「見つからない」と同じ見え方にしてはいけない。片方だけが「別の語で試せ」を意味する。' +
      '索引はトリガでDB側が維持する。呼び出しを覚えておく方式の索引は、新しい書き込み経路が増えた瞬間にずれる。' +
      '全会話を毎回モデルに送る解法はハンドオフで名指しで禁止されているため、' +
      'ツールとして提供する。検索はトークンではなくクエリ1回のコストで済む。'
  },
  {
    key: 'decision_trace',
    title: 'Decision Trace',
    domain: 'observability',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'activity_logs に決定イベントの記録は始まっているが、根拠・適用ルール・代替案を含む構造化トレースにはなっていない。',
    dependencies: ['activity_log'],
    source: `${V4} §55`,
    evidence: [
      'server/core/decision_trace.ts',
      'server/services/decisions_sqlite.ts',
      'db.ts migration 15（decisions）',
      'scripts/test-decisions.ts（28件）',
      '実データ: 本日の判断6件を投入し、affecting / unweighed で引けることを確認',
    ],
    notes: '監査(2026-08-19): decisionTrace / decision_trace は server 配下に存在しない。PARTIAL は誤りで、未実装。',
  },
  {
    key: 'project_state_autosync',
    title: 'Project State 自動同期',
    domain: 'personal_state',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason: 'フェーズ完了時やユーザーの依頼時だけでなく、意味のあるイベントごとに更新する。',
    dependencies: ['project_topic_foundation'],
    source: `${V4} §25`,
  },
  {
    key: 'experience_store',
    title: 'Experience / Playbook レイヤ',
    domain: 'learning',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason: '成功と失敗を再利用可能な経験として蓄積する。過去の成功は根拠であって法則ではない。',
    source: `${V4} §52`,
    evidence: [
      'server/core/experience.ts',
      'server/services/experiences_sqlite.ts',
      'db.ts migration 16（experiences）',
      'scripts/test-experience.ts（22件）',
      'server/tools/memory.ts の has_this_been_tried / record_experience',
      '実データ: 本日の試み11件を投入し、3件の反復failureを検出',
    ],
  },
  {
    key: 'failure_learning',
    title: 'Failure Learning',
    domain: 'learning',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '同種の失敗の反復を「これは構造的な設計問題か？」という問いに接続する。',
    dependencies: ['experience_store'],
    source: `${V4} §53`,
  },

  // -------------------------------------------------------- google workspace
  {
    key: 'google_calendar',
    title: 'Google Calendar 連携',
    domain: 'google_workspace',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      'REST API 経由で実装・実機確認(2026-08-19)。実カレンダー2件から予定12件を1.1秒で取得。' +
      'MCP 経由は断念した — 認可は通るが tools/call が全て "The caller does not have permission" で弾かれる。',
    dependencies: [],
    evidence: [
      'server/services/google_calendar.ts',
      'scripts/test-google-calendar.ts（32件）',
      'commit 78b34b2',
      '実機: source=google / カレンダー2件 / 予定12件 / 1131ms',
      '日次フォーカスに source=google で反映を確認',
    ],
    source: `${SUPP} §1`,
    risk:
      '更新トークンは OAuth クライアントが External + Testing の間、7日で失効する。つまりこの認可は7日ごとに切れるのが正常動作であって、異常ではない。' +
      '失効時は refresh_expired として「再認可が必要」と言わせているが、その経路はユニットテストで確認しただけで、実際に7日経過した状態はまだ観測していない。',
    notes:
      '依存を外した(2026-08-20)。life_state に依存する形になっていたが、life_state 側も google_calendar に依存しており循環していた — ' +
      'しかも向きが逆で、カレンダーを REST で読むのに「現在を組み立てる層」は要らない。' +
      '循環は今日より前から存在し、誰も気づいていなかった。検出テストを test-register.ts に追加した。' +
      '完了条件のうち「許可された Write」は意図的に未実装。要求スコープは readonly 2件のみで、書き込み能力を持たない。' +
      'カレンダーへの書き込みは承認境界の内側に置くべきもので、同意画面を一度クリックさせて恒久的に開けておくものではない。' +
      'MCP を諦めた経緯（他の Google サービスを足すとき同じ壁に当たる可能性がある）: 認可は完全に成功しており、同じトークンで Calendar REST API は 200 を返す。' +
      '要求スコープはサーバ自身の oauth-protected-resource メタデータが scopes_supported に列挙しているもの。Calendar MCP API はプロジェクトで有効化済み。' +
      'x-goog-user-project による quota project 指定は効果なし。calendar.readonly への拡大も試したが症状は不変だったため差し戻した。' +
      '残る候補は「OAuth クライアントが External + Testing であること」だが未確認。' +
      '判別方法(2026-08-20): 再認可は 2026-08-20 01:16 JST。External + Testing ならリフレッシュトークンは7日で失効するので、' +
      '2026-08-27 01:16 JST 前後に google_calendar.refresh_failed が出れば確定する。出なければ Testing ではない。' +
      '確定した場合の対処は Google Cloud コンソールで公開ステータスを In production にすること（利用者の操作）。' +
      '追試(2026-08-20): 有効なトークンと正しい2スコープで tools/call を直接呼んでも同じ「The caller does not have permission」。'  +
      'クライアントシークレットの不具合とは無関係に再現するため、この経路は使えないという前回の結論は正しい。' +
      '障害(2026-08-19 13:00 〜 2026-08-20 16:16): Google 経路が全停止していた。原因は .env の GOOGLE_CLIENT_SECRET 二重定義で、' +
      'dotenv は後勝ちのため正しい値(GOCSPX-)が後方の別値に上書きされていた。リフレッシュが 401(expired:false)で落ち、' +
      'トークンは正しく無効化されたが、以後 configured() が false になり Google は寄与ゼロのまま無言で飛ばされ続けた。' +
      'この間 Google 分の予定はキャッシュ(最大7.5時間前)だけが供給していた。再認可後、14日窓で12件・カレンダー2件を取得して復旧を確認。' +
      'ソース順は Google → FDPキャッシュ → EventKit。速度ではなく「各ソースが何を正直に主張できるか」で並べてある。' +
      'Google はローカル権限を必要とせず（launchd で壊れない）、今この瞬間の事実を答えられる。' +
      'キャッシュはファイルなので自分が古いことを知り得ず、実際に7日古いまま毎朝レンダリングされていた。' +
      'EventKit は責任プロセスに権限が帰属するため launchd 下では拒否される。' +
      'フォールバックした場合、その理由が結果に同行して日次フォーカスと 503 に届く。フォールバック自体は正しい（古い答えでも無いよりまし）が、' +
      '黙って落ちるのはこの順序が防ごうとしている失敗そのもの。特に更新トークンの失効は人が同意し直す必要があり、症状が「答えが静かに古くなる」だけでは誰も気付かない。' +
      '【訂正(2026-08-19)】「第一のソース」ではなくなった。Google が答えられるのは Google が知っていることだけで、' +
      'iCloud の 自宅 / 職場 は見えていなかった。全ソースをマージする方式に変更（icloud_caldav_calendar 参照）。',
  },
  {
    key: 'icloud_caldav_calendar',
    title: 'iCloud カレンダー（CalDAV）',
    domain: 'google_workspace',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'Google が見えないカレンダーがあったため。実測(2026-08-19): Google 12件に対しローカルキャッシュ16件で、' +
      '差の4件は iCloud の 自宅 / 職場。うち1件は2日後の予定で、日次フォーカスはそれを知らないまま「次は5日後の試験」と答えていた。',
    resumeCondition: null,
    dependencies: ['google_calendar'],
    evidence: [
      'server/services/caldav_calendar.ts',
      'scripts/test-caldav.ts（23件）',
      'scripts/verify-icloud.ts',
      'commit ad6995b',
      '実機: 3カレンダー10件を取得。マージ後23件、次の予定が正しく更新された',
      '時刻の正しさは利用者が確認済み（8/20 19:30 そよかぜ書店 他）',
    ],
    source: `${SUPP} §1`,
    risk:
      'App用パスワードは Apple ID の2ファクタ認証が前提。無効化されると読めなくなる。' +
      '認証失敗は caldav_unauthorized として「App用パスワードか確認せよ」と言わせている — ' +
      'Apple ID のパスワードでは通らないことが最も多い誤り。',
    notes:
      '移行ではなく読み取りを選んだ。Google へ移せば iPhone での予定作成先が変わり、公開カレンダーにすれば' +
      'URL を持つ誰でも読める。商談の入ったカレンダーには割に合わない。CalDAV は何も動かさない。' +
      '依存は追加していない。CalDAV の応答は機械生成XMLで、必要な要素はごく少ない。' +
      '繰り返しはサーバ側に展開させる（c:expand）ので、iCalendar で唯一本当に難しい RRULE 演算を持たずに済む。' +
      '【置き換えた経路より多く見える】キャッシュの 職場 は1件、CalDAV では7件。差は全て繰り返し予定で、' +
      'AppleScript の whose 句は繰り返しを展開しないため、シリーズ開始日が窓の外にあると1件も返らない。' +
      'これらの予定は FDP ダッシュボードに一度も出たことがないはず。' +
      '【実行して初めて分かった2つの誤り。どちらもエラーではなく「答え」の顔で出る】' +
      '(1) 構成要素フィルタが name="VEVENT" を探していたが iCloud は name=\'VEVENT\' と書く。' +
      '属性の引用符はサーバの自由。結果、アカウント内の全カレンダーが「予定を持たない」と分類され、空のアカウントと区別できなかった。' +
      '(2) タイムゾーン変換の収束補正を目標ではなく前回の推測との差で計算していた。1周目で正しく着地し2周目で同じだけずれる。' +
      '東京の20:00が11:00になった — 会議の時刻として何もおかしくないので、出力を見ても気づけない。' +
      'キャッシュ側が同じ予定を20:00で持っていたので照合できた。',
  },
  {
    key: 'google_tasks',
    title: 'Google Tasks 連携',
    domain: 'google_workspace',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '同上。Write 操作は承認方針に従う。',
    dependencies: ['google_calendar'],
    source: `${SUPP} §1`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },
  {
    key: 'gmail_integration',
    title: 'Gmail 連携',
    domain: 'google_workspace',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: 'Important Communication と金融通知取り込みの前提。',
    dependencies: [],
    risk: '機密情報を無条件に外部 LLM へ全文送信しないこと。',
    source: `${SUPP} §1`,
    notes: '循環依存を解消(2026-08-20、独立監査の指摘)。important_communication_engine に依存する形になっていたが、' +
      'そちらも gmail_integration に依存しており、レジスタの論理では両者が永遠に着手できなかった。' +
      'この項目の reason 自身が「Important Communication と金融通知取り込みの前提」と書いており、Gmail は依存する側ではなく前提の側。' +
      '実態も先行していた: OAuth・GmailClient・実機234通の取得が finance_gmail_intake として完成しており、一般読み取りへ広げる土台はある。' +
      '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
    resumeCondition:
      '土台は完成済み（OAuth・GmailClient・実機234通の取得）。残るのは利用者が一般読み取りまで広げるかの判断。',
  },
  {
    key: 'google_drive',
    title: 'Google Drive 連携',
    domain: 'google_workspace',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '文書検索・Evidence 取得・Domain Knowledge との関連付けに利用する。',
    risk: '機密情報を無条件に外部 LLM へ全文送信しないこと。',
    source: `${SUPP} §1`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },

  // ------------------------------------------------- real-world integration
  {
    key: 'important_communication_engine',
    title: 'Important Communication Engine',
    domain: 'communication',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      '目的は「重要そうなメッセージを見つける」ことではなく、「知る・決める・行動する必要が変化した通信を見つける」こと。',
    dependencies: ['gmail_integration', 'life_state'],
    source: `${SUPP} §2`,
    notes: '評価指標: False Positive / False Negative / False Merge / missed action / duplicate alert。',
  },
  {
    key: 'webclass',
    title: 'WebClass 連携',
    domain: 'external_service',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '過去の実装報告は未確認。認証済み Session が永久に有効だと仮定しないこと。',
    resumeCondition: '実サービスでの手動ログインと Session 永続化の検証準備が整った時点。',
    source: `${SUPP} §3`,
    notes:
      '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。' + '巡回頻度は事前に決め打ちせず、実運用データから調整する。',
  },
  {
    key: 'line_integration',
    title: 'LINE 連携（受信のみ）',
    domain: 'communication',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '署名検証・Webhook 重複処理・安全なパースが前提。Human-in-the-Loop を維持する。',
    dependencies: ['important_communication_engine'],
    risk: 'LINE 経由のメッセージが Mac の破壊的権限を暗黙に得てはならない（Surface Capability Boundary）。',
    source: `${SUPP} §4`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },
  {
    key: 'iphone_presence',
    title: 'iPhone / Mobile Presence',
    domain: 'surfaces',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '会話・Context Handoff・Quick Capture・Voice・Location・Driving Mode の受け皿。',
    dependencies: ['context_handoff'],
    risk: 'IRIS 通信を Apple Account 同期へ依存させないこと。LAN 外アクセスは経路設計を先に行う。',
    source: `${SUPP} §5`,
    notes: 'Shortcuts を作る前に、対応 Endpoint が実在するか確認すること。',
  },
  {
    key: 'context_handoff',
    title: 'Context Handoff（デバイス間の会話継続）',
    domain: 'surfaces',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '状態はブラウザタブではなく IRIS に属する。「さっきの続き」が別デバイスで成立すること。',
    dependencies: ['reliable_state', 'cross_thread_retrieval'],
    source: `${V4} §67`,
  },
  {
    key: 'sleep_wake_catchup',
    title: 'Sleep / Wake Catch-up',
    domain: 'foundation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      'Mac 常駐として Sleep・Offline・Network 切断・restart を前提にする。寝ていた間の poll を全部再実行しない。',
    dependencies: ['google_calendar'],
    source: `${SUPP} §6`,
    notes: 'last successful sync → delta → dedup → relevance → State 更新 → 必要なものだけ通知。',
  },
  {
    key: 'morning_briefing',
    title: 'Morning / Daily Briefing',
    domain: 'proactive',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '目的は「知っていることを全部読む」ではなく「今日何をすべきかを変える情報を出す」こと。',
    dependencies: ['life_state', 'attention_policy'],
    source: `${SUPP} §7`,
  },
  {
    key: 'annual_life_integration',
    title: 'Annual Academic / Career / Life Integration',
    domain: 'personal_state',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '高価値の将来機能。大学年間予定・試験・実習・研究・キャリア・IRIS 開発ロードマップを統合する。',
    dependencies: ['life_state', 'project_topic_foundation'],
    source: `${SUPP} §8`,
    notes: 'Raw transcript を直接 Canonical State にしない。Extraction → Structured Proposal → 必要なら確認。',
  },
  {
    key: 'departure_eta',
    title: 'Departure / ETA Intelligence',
    domain: 'proactive',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'ETA が少し変わるたびに通知しない。意味のある差分だけ。閾値は実生活で校正する。',
    dependencies: ['google_calendar', 'iphone_presence', 'attention_policy'],
    source: `${SUPP} §21`,
  },

  // ------------------------------------------------------------------ voice
  {
    key: 'voice_presence_mvp',
    title: 'Voice Presence MVP（TTS / push-to-talk）',
    domain: 'voice',
    status: 'PLANNED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P3',
    reason:
      '体験価値が高く、基盤が安定した後の早期実装候補。すべての backend 完成を待つ必要はない（v4 §68）。',
    dependencies: ['reliable_state'],
    source: `${V4} §11.7, P1-15`,
    resumeCondition:
      'TTS と barge-in と音声ヘルパの常駐は実機検証済み。残るのは push-to-talk の UI と、それらを1つの体験としてまとめること。',
    notes:
      '実態に合わせて更新(2026-08-20、独立監査の指摘)。NOT_IMPLEMENTED のまま取り残されていたが、構成要素は既に動いている — ' +
      'google_chirp3_hd_tts が REAL_WORLD_VERIFIED、barge_in が実機で「ちょっ」の3文字で停止を確認、' +
      'speech_helper_launchd_packaging が TCC の帰属問題を解決して常駐。' +
      'PARTIAL としたのは、個々は動くが「音声で話しかけて音声で返る」体験としてまとまっていないため。' +
      'なお音声は macOS 固有資産（EventKit / IrisSpeech.app / TCC）に依存する。常駐機は macOS と決まったため(2026-08-20)、この資産は移行後も使える。',
    evidence: [
      'google_chirp3_hd_tts（REAL_WORLD_VERIFIED）— Chirp 3 HD / Enceladus、文分割で初音 3.6→2.1秒',
      'barge_in — 実機で「ちょっ」の3文字で停止を確認',
      'speech_helper_launchd_packaging — TCC の帰属問題を解決して常駐',
      'server/services/speech_bridge.ts / speech_agent.ts / tts.ts',
    ],
  },
  {
    key: 'voice_experience_details',
    title: 'Voice 詳細（日本語正規化・発音辞書・barge-in 等）',
    domain: 'voice',
    status: 'CURRENT',
    verification: 'RUNTIME_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P2',
    reason:
      '発音辞書と表記の正規化（日付・時刻）を実装済み。barge-in は未着手のため PARTIAL。',
    resumeCondition: '実運用で読み間違いや遅延が観測された時点で、残りを個別に着手する。',
    dependencies: ['voice_output'],
    source: `${SUPP} §22`,
    evidence: [
      'server/services/pronunciation.ts',
      'server/services/speech_text.ts',
      'db.ts migration 10（pronunciations）',
      'scripts/test-pronunciation.ts（33件）',
      'scripts/test-speech-text.ts（33件）',
      'server/core/barge_in.ts',
      'scripts/test-barge-in.ts（29件）',
      '実機: 自己発話41秒を完走し、「ちょっ」で21秒地点で停止することを確認',
      '実機: 端末音声が 平滑筋 を へいかつすじ と読んだのを確認し、辞書で補正',
      '実機: Chirp 3 HD が 8/24 を「にじゅうよんぶんのはち」と読んだのを確認し、表記の正規化で解決',
    ],
    notes:
      '【表記の正規化(2026-08-19)】Chirp 3 HD は 8/24 を「にじゅうよんぶんのはち」と読んだ。' +
      '発音の誤りではなく、同じ文字列の別の解釈であり、しかも妥当な解釈でもある — ' +
      '数字に挟まれたスラッシュは日付と同じくらい分数でもある。' +
      '音として破綻していないので、聞いていても気づけない種類の誤り。' +
      'かなに変換せず日本語表記に直す（8/24 → 8月24日）。' +
      '「24日＝にじゅうよっか」のような不規則な読みは月の3割ほどあり、それを自前で持つと' +
      'エンジンを乗り換えるたびに持ち直すことになる。表記を直すだけなら声が変わっても知識が残る。' +
      '3/4 が「3月4日」になるのは意図的に受け入れた代償。分数と日付は同じ表記で、どちらかに決めるしかない。' +
      'IRIS が声に出すのは予定・締切・進捗なので日付を採った。' +
      '分数を日付と読めば人はすぐ気づいて報告できるが、日付を分数と読む方は誰も気づいていなかった。' +
      'URL とパス、3個以上のスラッシュ区切り（版番号）は対象外。時刻の分は2桁必須なので 1:1 は時刻と見なさない。' +
      '正規化 → 発音辞書 の順。8/24 が 8月24日 になってからでないと、日 を鍵にした読みが当たらない。' +
      '【barge-in 実装(2026-08-19)】partial（確定前の認識結果）で判定する。final を待つのは'
      + 'ユーザーが話し終わるのを待つことで、それは割り込まれたのではなく怒鳴られただけ。'
      + '難しいのは機構ではなく、マイクがスピーカーを拾うこと。素朴に繋ぐとIRISは喋り始めた瞬間に'
      + '自分の声で自分を止める — 毎回、最初の一語で。3段で分ける: 発話直後の猶予(900ms)、'
      + '最短文字数(3)、そして自己エコー判定（認識結果が読み上げ中の文の一部に一致するか）。'
      + '判定には読み上げ中の「文字列」が要る。喋っているという事実だけでは足りない。'
      + '誤って止めるのと、利用者に被せて喋り続けるのとでは後者が悪いので、エコーを越えられる範囲で'
      + '各段はできるだけ緩くしてある。中断は失敗ではない — 再試行せず、結果には interrupted として'
      + '記録する。会話記録が「全部言った」と主張すると、聞かれていない発話を前提に次が積まれる。'
      + 'ただし何が聞こえたかは原理的に分からない（音声はバッファされる）ので、'
      + '主張するのは「最後まで言い切っていない」ことだけ。'
      + '【実機で検証(2026-08-19)】マイクが launchd 下で開くようになったので実際に試し、2つの欠陥が出た。'
      + 'どちらもユニットテストでは出なかった。'
      + '(1) エコー判定が「一致した連続部分が認識文字列の60%以上か」だった。認識は途中で必ず食い違う — '
      + '実測では 8月24日 が 8月二十 4日 と書き起こされた — ので一致できる長さはそこで頭打ちになる。'
      + '一方で閾値は認識文が伸びるほど上がる。結果、エコーが長引くほど「他人の声」と判定されやすくなり、'
      + '2秒間正しく抑制したあとで自分の声に割り込んだ。この機構が防ぐべき失敗そのもの。'
      + '割合ではなく絶対長（8文字）に変更。日本語で連続8文字が偶然一致することはない。'
      + '(2) 停止が再生中に入ると例外にならず、結果が interrupted を報告しなかった。'
      + '全セグメント書き込み済みで finish() が正常終了するため。実測11.8秒で止まったのに'
      + '「35秒の発話を完了した」という記録になっていた。言い切っていないのに言い切ったと記録するのは'
      + 'この機能で最も避けたかったこと。中断したかどうかはエンジンの戻り方ではなく abort signal の性質なので、'
      + '例外時だけでなく正常終了時にも確認するようにした。'
      + '修正後の実測: 何も話さなければ41秒を完走（修正前は11.8秒で自壊）、'
      + '「ちょっ」の3文字で21秒地点で停止し interrupted=true / interruptedBy=barge_in。' +
      '筋 は日常語では「すじ」、解剖では「きん」— 言語とドメインの性質であってベンダの欠陥ではない。' +
      '筋 は日常語では「すじ」、解剖では「きん」— 言語とドメインの性質であってベンダの欠陥ではない。' +
      'どのエンジンも別々の語を取り違えるので、補正は全エンジンの上に1箇所だけ置く。' +
      'SSML ではなく かな置換にした: Chirp 3 HD の SSML 対応は限定的で、' +
      'かな置換ならエンジンを乗り換えても知識が残る。' +
      '置き換わるのは読み上げる文字列だけで、画面と会話履歴は変えない — ' +
      '「平滑筋」の代わりに「へいかつきん」と表示されるログは、間違いを別の間違いに置き換えただけ。' +
      '最長一致を先に適用する（筋 だけが当たると 平滑きん になる）。' +
      '置換後のかなが別の項目に再マッチしないよう、1語ごとに結果を確定させる。' +
      'ユーザーが耳で直した項目は seed より優先する — 聞いたのは本人であってこちらではない。' +
      '既定の辞書は短くしてある。確信のない読みを入れた辞書は、辞書がないより悪い: ' +
      '誤りが静かに一貫して適用され、まさにそのせいで気づかれなくなる。'
  },

  // ------------------------------------------------------------------ models
  {
    key: 'model_lifecycle_registry',
    title: 'Model Availability / Lifecycle 管理',
    domain: 'models',
    status: 'CURRENT',
    verification: 'RUNTIME_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P2',
    reason:
      'Model ID が永続的に使える前提を置かない。実際に設定済み Gemini モデルが利用不能になり実機修正を要した事例がある。' +
      '発見・非推奨検知・最終確認日時の保存までを実装。自動フォールバックのみ未着手のため PARTIAL。',
    resumeCondition: 'モデル廃止・利用不能が再度発生した時点、または Provider 追加時。',
    risk: 'Provider 側の廃止で Business Logic 全体の書き換えが必要になる構造を避ける。',
    source: `${SUPP} §23`,
    evidence: [
      'server/services/model_discovery.ts の discoverGeminiModels / ModelCheckStore / checkConfigured',
      'db.ts migration 13（model_checks）',
      'scripts/test-model-lifecycle.ts（32件）',
      '実機: 3プロバイダの設定モデルを起動時に確認（model.verified: checked=3, missing=0）',
      '実機: 存在しないモデルIDを設定して再起動し、model.retired の警告と候補提示を確認',
      '実機: 再起動をまたいで last_present_at が保持されることを確認',
    ],
    notes:
      '【実装(2026-08-19)】Gemini を発見対象に追加。ここが最大の穴だった — 発見は Anthropic と OpenAI だけを' +
      '見ており、IRIS が実際に動いているプロバイダであり、かつ事故を起こした当のプロバイダが検査されていなかった。' +
      'モデルIDは models/gemini-2.5-flash の形で返るので接頭辞を剥がす。剥がさないと設定値と一致せず全件を欠落と報告する。' +
      'supportedActions で generateContent を持つものだけを代替候補にする。名前が似ていても image や embedding は' +
      '会話できないので、提案した瞬間に失敗する候補になる。' +
      '起動時と6時間ごとに検査する。発見自体は前からあったが誰も走らせておらず、' +
      '「モデルが消えた」と分かるのは実行が失敗したときだった — しかも問題になる実行は' +
      '朝6時の、誰も見ていないものになる。起動は遅らせず、失敗しても致命的にしない。' +
      '到達できないことはモデルが消えた証拠ではなく、通信の一時障害で起動を拒否する方が防ごうとしている事故より悪い。' +
      'migration 13 の model_checks に「いつ最後に存在を確認したか」を残す。発見が答えるのは「いま在るか」で、' +
      '再起動後に効くのは「最後に分かっていたのはいつか」の方。present は NULL 可 — ' +
      '到達できなかったことを false として保存すると、通信障害が全て提供終了に化ける。' +
      '【実機で壊して確認】存在しないモデルIDを設定して再起動し、model.retired の警告と候補提示が出ることを確認した。' +
      'その過程でバグを1つ発見: last_present_at は setting を鍵にしていたため、設定モデルを変えると' +
      '前のモデルの目撃時刻が引き継がれ、「最後に動いていたのはいつか」が別モデルの話になっていた。' +
      'モデル値が変わったら破棄するよう修正。壊してみなければ出てこなかった。' +
      '【残り】自動フォールバック（欠落時に候補へ切り替える）は未実装。モデルの差し替えは費用と挙動が変わるので、' +
      'provider_router のプロバイダ単位のフェイルオーバー（model-not-found で次へ）で足りるかを見てから判断する。' +
      '旧記述: 発見は稼働中、非推奨検知とフォールバック方針は未実装なので PARTIAL。' +
      '監査(2026-08-19): discoverAll / checkConfiguredModel が実装され /api/models で稼働。発見は実在するが、非推奨検知とフォールバック方針は未実装のため PARTIAL のまま。' + 'available model discovery / deprecation detection / fallback policy / last verified availability。',
  },
  {
    key: 'model_routing_calibration',
    title: 'Model Routing の実測校正',
    domain: 'models',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      'Public Benchmark だけで Routing を決めない。IRIS 自身の実ワークロードを重要な Evidence とする。',
    dependencies: ['development_telemetry', 'openai_provider'],
    source: `${SUPP} §24`,
  },
  {
    key: 'model_intelligence',
    title: 'Model Intelligence（証拠ベースのモデル特性）',
    domain: 'models',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      'ModelResourceManager の実装報告があるが未確認。「モデル X が常に最良」という固定観念を持たない設計にする。',
    dependencies: ['model_routing_calibration'],
    source: `${V4} §51`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },

  // ----------------------------------------------------------------- finance
  {
    key: 'finance_csv_jcb',
    title: 'JCB CARD W CSV アダプタ',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'JcbCsvAdapter の実装報告があるが監査で未確認。現在のマイルストーンではない。',
    resumeCondition: '金融パイプラインが能動的なマイルストーンになった時点。',
    risk: '実金融 CSV をリポジトリの Fixture にコミットしないこと。',
    source: `${SUPP} §9`,
    notes:
      '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。' + 'Fixture だけで REAL_VERIFIED にしない。Encoding・Header・日付・金額・Debit/Credit を実データで確認。',
  },
  {
    key: 'finance_csv_pocket_card',
    title: 'Pocket Card CSV アダプタ',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '同上。PocketCardCsvAdapter は監査で未確認。',
    resumeCondition: '金融パイプラインが能動的なマイルストーンになった時点。',
    source: `${SUPP} §9`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },
  {
    key: 'finance_csv_sbi_shinsei',
    title: 'SBI新生銀行 CSV アダプタ',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '同上。SbiShinseiCsvAdapter は監査で未確認。',
    resumeCondition: '金融パイプラインが能動的なマイルストーンになった時点。',
    source: `${SUPP} §9`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },
  {
    key: 'finance_import_idempotency',
    title: '金融インポートの冪等性',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      '日付＋金額＋店舗だけの重複判定は、正当な複数決済を誤削除する。Source Identity / Import Provenance を使う。',
    resumeCondition: '金融 CSV アダプタが実装された時点。',
    dependencies: ['finance_csv_jcb'],
    risk: '正当な同日同額同店舗の2決済を消してしまう。',
    source: `${SUPP} §10`,
  },
  {
    key: 'finance_gmail_intake',
    title: '金融メール取り込み',
    domain: 'finance',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P4',
    reason: 'Unknown Template は安全に失敗する。認識できないメールから金額を推測して記録しない。',
    dependencies: ['gmail_integration'],
    risk: '金融メール本文を無条件に外部 LLM へ全文送信しないこと。',
    source: `${SUPP} §11`,
    evidence: [
      'server/core/finance_email.ts（テンプレート3件）',
      'server/services/gmail_client.ts',
      'server/services/google_oauth.ts',
      'scripts/test-finance-email.ts（49件、実物のメールを転記）',
      '実機: 234通取得、182件取り込み、55通をテンプレート無しとして拒否、読めなかった行0（2026-08-20）',
    ],
    notes:
      '実装(2026-08-20)。テンプレートは実物のメールから起こした — ポケットカード / JCB即時 / JCB売上到着分。' +
      'JCB の2種類は差出人が同じ(mail@qa.jcb.co.jp)なので本文の目印で分ける。日付の項目名も違う(ご利用日時(日本時間) / ご利用日)。' +
      '売上到着分は1通に複数件入るので ◆ご利用 ごとに切る。JCB 自身が「売上到着分はカードご利用時に通知していないものが対象」と' +
      '書いているため、即時通知とは排他で二重計上しない。' +
      'ポケットカードの利用先は毎回 Mastercard加盟店 で店名ではないため、(利用先不明) として印を付ける — ' +
      'これを店名として扱うとカテゴリ規則が全支出に当たる。' +
      '実機で55通が拒否され、すべて宣伝・明細確定通知だった。JCB の本文には Amazonプライム年会費 5,900円 が例示として書かれており、' +
      '「数字＋円」を探す実装ならこれを拾う。テストで拾わないことを固定した。' +
      '取り込み時に2つ捕まえた: エラー本文の切り詰めが対処法の URL を消していたこと、' +
      '取得の打ち切りが無言である月の合計を実際の数十分の一に見せていたこと。後者はページングで解決し、上限到達は truncated として返す。' +
      'Gmail の OAuth は MCP とは別経路（素の authorization code + PKCE）。リダイレクトは登録済みの /api/mcp/oauth/callback を共用し、' +
      'state に記録したサービス名で分岐する — 独自パスは redirect_uri_mismatch で弾かれた。'
  },
  {
    key: 'finance_pending_confirmed_model',
    title: 'Pending / Confirmed 金融モデル',
    domain: 'finance',
    status: 'COMPLETED',
    verification: 'UNIT_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P4',
    reason: 'Gmail 利用通知は Pending、CSV は Confirmed。同一支出を二重計上しない。',
    dependencies: ['finance_gmail_intake', 'finance_csv_jcb'],
    source: `${SUPP} §12`,
    evidence: [
      'server/core/finance_reconcile.ts',
      'server/services/finance_sqlite.ts の reconcilePending',
      'scripts/test-finance.ts（107件、うち突合20件）',
      'db.ts migration 21',
    ],
    notes:
      '実装(2026-08-20)。pending は当面その支出の唯一の記録なので合計に入り、confirmed が突合されると superseded になって合計から外れる。' +
      '行は消さない — 「いつ最初に知ったか」が答えられなくなるため。' +
      '突合は金額の完全一致と日付の窓のみ。同額の候補が複数ある場合は突合せず ambiguous として報告する — ' +
      'どちらか選ぶと購入が1件消え、しかも気づけない。finance_reconciliation の「fixture だけで閾値を最適化しない」に従い、窓は引数にしてある。'
  },
  {
    key: 'finance_reconciliation',
    title: '金融 Reconciliation',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'Fixture だけで閾値を最適化しない。実データで True/False/Missed Match を測定して調整する。',
    dependencies: ['finance_pending_confirmed_model'],
    source: `${SUPP} §13`,
    notes:
      '機構は finance_pending_confirmed_model として実装済み(2026-08-20)。ただし本項目の要求は閾値の校正であり、そちらは未実施。' +
      '現在の突合は金額の完全一致と日付の窓(既定3日)のみで、同額の候補が複数あるときは突合せず ambiguous として報告する。' +
      '窓は引数にしてあるので、実データで True/False/Missed Match を測ってから決められる。' +
      'Gmail 側に182件の pending が入ったので、カード明細の CSV を取り込めば実測できる状態になった。'
  },
  {
    key: 'cash_flow_forecast',
    title: 'Cash Flow Forecast',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      'Confirmed と Estimated を必ず分離する。給与日を推測しない。Balance が古い場合は STALE と明示する。',
    dependencies: ['finance_reconciliation'],
    risk: '確実でない予測を確定情報のように表示すること。',
    source: `${SUPP} §14`,
  },
  {
    key: 'finance_attention_calibration',
    title: 'Financial Attention の校正',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'LOW_BUFFER 等の閾値を事前に決め打ちしない。実残高・支払／給与タイミング・False Alarm を観測して調整。',
    dependencies: ['cash_flow_forecast'],
    source: `${SUPP} §15`,
  },
  {
    key: 'finance_local_boundary',
    title: '金融・税務データのローカル境界',
    domain: 'finance',
    status: 'CURRENT',
    verification: 'DESIGNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      '金融・税務は通常の Project Metadata より強く保護する。Local-first・最小保持・リポジトリに入れない・自動クラウドバックアップしない。',
    source: `${SUPP} §18`,
    notes: '方針として常時有効。金融機能を実装する時点で技術的に強制する。',
  },
  {
    key: 'tax_maintenance',
    title: 'Tax 機能の維持',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'Scope Controlled。勝手に高度な Tax Case へ拡張しない。',
    resumeCondition: '法改正・実バグ・ユーザーの明示的な機能要求のいずれか。',
    source: `${SUPP} §16`,
    notes: '年度更新は公式一次情報を確認してから。Hardcoded fallback threshold を勝手に再導入しない。',
  },
  {
    key: 'receipt_ocr',
    title: 'Receipt / Expense OCR',
    domain: 'finance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '技術的に可能というだけの理由で実装しない。明確に意図的な保留。',
    resumeCondition: '実際に領収書処理の必要性が発生した時点。',
    source: `${SUPP} §17`,
  },

  // ------------------------------------------------------------------ pilot
  {
    key: 'pilot_soak_test',
    title: 'Pilot / Soak Test',
    domain: 'validation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      'SoakTestService / PilotReadinessService の実装報告があるが監査で未確認。存在すると仮定しない。数日〜数週間の実生活運用で評価する。',
    resumeCondition: '実生活で常用できる機能が揃った時点。',
    source: `${SUPP} §19`,
    notes:
      '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。' +
      'Pilot Success は「Server が落ちなかった」ではなく「日常で役立ち、過剰な監督を要求しなかった」こと。',
  },
  {
    key: 'attention_policy',
    title: 'Attention Policy',
    domain: 'proactive',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '通知を最大化しない。IGNORE / REMEMBER / SURFACE_LATER / NOTIFY / ASK_USER / ACT を判断する。',
    dependencies: ['life_state'],
    source: `${V4} §63, §64`,
  },
  {
    key: 'attention_policy_calibration',
    title: 'Attention Policy の Pilot 校正',
    domain: 'validation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '閾値の最適値を事前に決めない。実 Pilot で調整する。',
    dependencies: ['attention_policy', 'pilot_soak_test'],
    source: `${SUPP} §20`,
  },
  {
    key: 'iris_bench',
    title: 'IRIS Bench',
    domain: 'validation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'モデル・Memory 設計・エージェント構成・外部技術を評価する共通の物差し。',
    dependencies: ['development_telemetry'],
    source: `${V4} §61`,
  },
  {
    key: 'user_burden_metric',
    title: 'User Burden の計測',
    domain: 'validation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      '成功は「IRIS が多くの操作をした」ことではなく「不要な作業を減らした」こと。手動コピペ回数を含めて計測する。',
    dependencies: ['activity_log'],
    source: `${V4} §62`,
  },
  {
    key: 'production_service_hardening',
    title: 'Production Mode への移行評価',
    domain: 'foundation',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      '現在の launchd は開発用起動（npm run dev）。ただし「Production という名前だから良い」という理由で変更しない。',
    resumeCondition: 'Reliable State と再起動検証の完了後。既に前提は満たしている。',
    dependencies: ['launchd_service'],
    source: `${SUPP} §25`,
    notes: 'Build・Startup・Environment・Restart・Logs・Failure recovery を確認したうえで価値を評価する。',
  },

  // -------------------------------------------------------------- intelligence
  {
    key: 'learning_graph',
    title: 'Learning Graph',
    domain: 'learning',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '個別の質問を孤立した Q&A に留めず、概念ネットワークへ写像する。',
    dependencies: ['memory_architecture'],
    source: `${V4} §33`,
  },
  {
    key: 'domain_map',
    title: 'Domain Map',
    domain: 'learning',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'ドメイン知識を1プロジェクトを越えて持続させ、再訪時は変化した部分だけ更新する。',
    source: `${V4} §50`,
  },
  {
    key: 'user_capability_model',
    title: 'User Capability / Working Style Model',
    domain: 'learning',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '不変のラベルとして保存しない。evidence・confidence・freshness を伴う。',
    source: `${V4} §35`,
  },
  {
    key: 'cross_project_synergy',
    title: 'Cross-Project Synergy 検出',
    domain: 'intelligence',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '別々に始まったプロジェクト間の機会を能動的に発見する。元のプロジェクトを自動で消さない。',
    dependencies: ['project_topic_foundation'],
    source: `${V4} §31`,
  },
  {
    key: 'project_conflict_detection',
    title: 'Project Conflict 検出',
    domain: 'intelligence',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '重複作業・資源競合・矛盾する計画・順序依存を検出する。',
    dependencies: ['project_topic_foundation'],
    source: `${V4} §32`,
  },
  {
    key: 'proactive_iris',
    title: 'Proactive IRIS',
    domain: 'proactive',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'observe → evaluate → ignore / remember / surface / ask / act のループ。',
    dependencies: ['life_state', 'attention_policy'],
    source: `${V4} §11.1`,
  },
  {
    key: 'innovation_radar',
    title: 'External Innovation Radar',
    domain: 'intelligence',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: 'ユーザーが繰り返し「他に改善案ない？」と尋ねなくて済むようにする。新しい＝良いではない。',
    source: `${V4} §43`,
  },
  {
    key: 'unsolved_problems_radar',
    title: 'Unsolved Problems Radar / Frontier Track',
    domain: 'intelligence',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '「何がまだ解けていないか」を追跡する。実験的コードを重要な本番経路に直接置かない。',
    source: `${V4} §44, §45`,
  },
  {
    key: 'whatif_simulation',
    title: 'Personal What-if Simulation',
    domain: 'intelligence',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '実際のユーザー状態の上で「今夜あと3時間やったら明日どうなるか」を推論する。',
    dependencies: ['life_state'],
    source: `${V4} §65`,
  },

  // ----------------------------------------------------------------- autonomy
  {
    key: 'agent_mission_control',
    title: 'Agent Mission Control',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'DESIGNED',
    reality: 'PARTIAL',
    priority: 'P3',
    reason:
      'agent_runs に heartbeat・進捗・停滞判定は実装済み。複数エージェントの統括と UI はこれから。',
    dependencies: ['development_task_handoff'],
    evidence: ['server/services/dev_tasks_sqlite.ts の assessRun'],
    source: `${V4} §22`,
  },
  {
    key: 'progress_eta_ui',
    title: '進捗 / ETA の UI',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: '偽の精度を出さない。5/8 milestones・推定 60〜75%・confidence: medium の形で表示する。',
    dependencies: ['agent_mission_control'],
    source: `${V4} §24, §45`,
  },
  {
    key: 'run_contract',
    title: 'Run Contract',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason: 'Autonomy within a bounded contract。Goal・許可範囲・禁止行為・予算・停止条件を明示する。',
    dependencies: ['agent_mission_control'],
    source: `${V4} §18`,
  },
  {
    key: 'autonomous_work_mode',
    title: 'Autonomous Work Mode',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '「形になるところまで進めて」に応えるための統括モード。',
    dependencies: ['run_contract', 'coding_agent_invocation'],
    source: `${V4} §17`,
  },
  {
    key: 'overnight_mode',
    title: 'Overnight Mode',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '就寝前に渡し、朝に有用な結果を受け取る。安全境界では必ず停止する。',
    dependencies: ['autonomous_work_mode', 'resilience_timeouts'],
    source: `${V4} §19`,
  },
  {
    key: 'iris_self_development',
    title: 'IRIS 自己開発（bounded）',
    domain: 'autonomy',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '目標構造であって、無制限の自己改変の許可ではない。',
    dependencies: ['overnight_mode', 'iris_bench'],
    risk:
      'IRIS が自身を監督する仕組み（承認方針・認証情報保護・ツール権限・安全境界）を自ら削除できてはならない。',
    source: `${V4} §15, §16`,
  },
  {
    key: 'universal_action_layer_mcp',
    title: 'Universal Action Layer / MCP',
    domain: 'action_layer',
    status: 'CURRENT',
    verification: 'RUNTIME_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P1',
    reason: '外部能力を Tool Registry へ収斂させる。任意の MCP サーバーへ無制限の権限を与えない。',
    dependencies: ['tool_trust_registry'],
    source: `${V4} §11.5, §57`,
    risk:
      'Google のホスト型 MCP サーバは、認可は通るが tools/call を拒否する状態がありうる。' +
      'Calendar で実際に発生し、REST へ退避した。Sheets / Drive / Gmail を足すときは、' +
      '接続成功ではなく tools/call の成功をもって「使える」と判断すること。',
    evidence: [
      'server/services/mcp_client.ts',
      'scripts/test-mcp.ts',
      '@modelcontextprotocol/sdk（公式SDK、StreamableHTTPClientTransport）',
      'server/services/oauth_provider.ts / oauth_store.ts',
      'scripts/test-oauth.ts（54件）',
      'commit 00692a2, f49d6ca',
      '実機: Google Calendar MCP に接続しツール9件を取り込み',
    ],
    notes:
      'P4 から P1 へ昇格(2026-08-19)。Google が Sheets / Calendar / Drive / Gmail の' +
      'ホスト型MCPサーバを提供しており、手作り4件の代わりにクライアント1本で届くため。' +
      '本体は取り込み口の安全性。MCP のツールは名前・説明・スキーマがすべて外部から来るうえ、' +
      'リスク階級を持たない — 「これは送信するので取り消せない」という概念が MCP に無い。' +
      'IRIS の承認境界はまさにその区別の上に建っているので、こちら側で、' +
      'サーバが影響できない規則から割り当てる。' +
      '分類できなかったツールは READ にしない。READ は自動実行されるので、' +
      '「判断できなかった」を「安全」と同じ扱いにできない。既定は WRITE（承認必須）。' +
      'READ への引き下げは、人が個別に確認してから明示的に指定する。' +
      '説明文はモデルの文脈に入るためインジェクション面。出所を明示して' +
      '「指示ではなくデータ」と付す（安全にはならないが、素性は分かる）。' +
      'ツール名は mcp__<server>__<tool> で名前空間化し、read_file のような組み込み名を' +
      '外部サーバが奪えないようにしている。' +
      '【OAuth 実装済み(2026-08-19)】公式SDKの OAuthClientProvider を実装。' +
      'PKCE・state・トークン永続化・失効までを db.ts migration 12 の2テーブルで扱う。' +
      'トークンは応答にもログにも一切出さない。前置きの断片も出さない — ' +
      'ベアラトークンの「安全な一部」というものは無い。' +
      'state を発行していないコールバックは拒否する。心当たりのないコールバックは' +
      'バグか攻撃のどちらかで、どちらもトークン交換で応えるべきものではない。' +
      'state は一度しか使えないので、再送されたコールバックは何も得られない。' +
      '要求スコープは readonly のみ。gmail.compose は意図的に外した — ' +
      '送信は外向きの能力で、IRIS の規則では推定起点の実行から到達禁止のはず。' +
      'スコープとして取れば、その判断が「一度クリックする同意画面」の裏に移ってしまう。' +
      '同意画面はサーバから開かない。URL を返して人が開く。' +
      '常駐サービスが無断で同意画面を出せる方が、出せないより悪い。' +
      '残: Google Cloud 側の設定（同意画面・スコープ・リダイレクトURI登録）は利用者の操作。' +
      'なお gviz で Sheet が引けると分かったため、日次フォーカスに MCP は不要になった。' +
      '【実運用で判明した4点(2026-08-19)。他の Google サービスを足すとき同じ穴に落ちる】' +
      '(1) SDK に scope を渡さないと、サーバが広告したスコープがそのまま要求される。' +
      'Calendar では12件が要求され、フルアクセスの .../auth/calendar と共有設定を変更できる .../auth/calendar.acls が含まれていた。' +
      'サーバは敵対的なのではなく能力を説明しているだけで、能力一覧を要求として受け取ったのがこちらの誤り。' +
      'auth() と startAuthorization() は scope を受けるので明示的に渡す。未定義なら黙って既定に落ちるのではなくエラーにする。' +
      '(2) tools/list は認証不要。したがって「接続成功・ツール9件」は認証の証明にならない。' +
      '実際にトークンが無い状態でも9件取れていた。証拠になるのは tools/call だけ。' +
      '(3) MCP は失敗を 200 応答の中の isError で返す。バイト数や例外の有無だけを見る検証は ' +
      '"The caller does not have permission" を成功として報告する。実際に一度そう報告した。' +
      '(4) PKCE verifier を保存するとき flow 行を作り直すと state が回転し、認可URLは古い state で' +
      '組み立て済みなので全てのコールバックが CSRF 検査で弾かれる。発行済み state に追記すること。' +
      'SDK の呼び出し順（URL構築 → verifier保存）を再現するテストがある。',
  },
  {
    key: 'fdp_daily_dashboard',
    title: 'Founder Development Program 日次ダッシュボード',
    domain: 'proactive',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'NONE',
    reason:
      'IRIS の外に既に実在し、毎朝 launchd で稼働している。' +
      '5領域（iOSカレンダー / 医学部の試験 / FDP / MedRecall・OS / 予備校＋ランサーズ）から' +
      '領域ごとに1件だけ出す読み取り専用ダッシュボード。',
    dependencies: [],
    evidence: [
      '~/Documents/Founder-Development-Program/DASHBOARD.md',
      'today.py / dashboard.py / calendar_sync.py / daily_refresh.sh',
    ],
    source: AUDIT,
    notes:
      '監査(2026-08-19)で所在を特定。C項目の Google 連携4件は、この既存実装の言い換えだった。' +
      '設計方針「全部並べるのではなく、今それをやるべきかを出す」は、' +
      'レジスタの attention_policy(P4) が目指しているものの実働版。ゼロから設計する必要はない。' +
      'データ源7つのうち5つは Google Sheet（MCP の射程）、1つはOSリポジトリのファイル直読み、' +
      '1つは Calendar.app（AppleScript、実測60〜75秒）で MCP の射程外。' +
      'IRIS へ取り込む場合、Calendar.app 部分は EventKit で置き換える余地がある' +
      '（既存の Swift ヘルパがあるため）。' +
      '注意: FDP は ~/Documents 配下で、ここも TCC 保護対象。' +
      '今 launchd で動いているのは python3 が許可を持っているためで、' +
      '実行体を変えると ~/Downloads で踏んだのと同じ無言のハングに当たる。',
  },
  {
    key: 'tool_trust_registry',
    title: 'Tool Trust Registry',
    domain: 'action_layer',
    status: 'CURRENT',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      'ToolTrust（TRUSTED_CORE / REVIEWED / EXPERIMENTAL / UNTRUSTED）は実装済みで、未指定は UNTRUSTED になる。外部ツールの審査プロセス自体は未整備。',
    evidence: ['server/tools/registry.ts', 'scripts/test-tools.ts'],
    source: `${V4} §53, §57`,
    notes: '監査(2026-08-19): registry が未指定のツールを UNTRUSTED として登録し、既定が安全側に倒れている。PARTIAL ではなく実在。',
  },
  {
    key: 'computer_control',
    title: 'Computer Control',
    domain: 'action_layer',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '決定的な API / CLI を、脆い GUI 自動化より優先する。',
    dependencies: ['shell_command_tool'],
    source: `${V4} §11.6`,
  },
  {
    key: 'iris_shell_ui',
    title: 'IRIS Shell（UI 刷新）',
    domain: 'surfaces',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      'premium / dark / minimal / calm。Reliable State より先に大規模な視覚刷新を優先しないが、それを妨げる設計もしない。',
    source: `${V4} §68`,
  },
  {
    key: 'deferred_feature_review',
    title: 'Deferred Feature の定期見直し',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '良い Idea の忘却を防ぎつつ、永遠に増える Backlog も防ぐ。register:review で見直しの導線を用意した。',
    dependencies: ['future_feature_register'],
    source: `${SUPP} §31`,
    evidence: [
      'scripts/register-review.ts',
      'future_features_service.ts の unblockedDeferrals()',
      'scripts/test-register.ts',
    ],
    notes:
      '保留が古びるのは時間が経ったからではなく、待っていたものが起きたとき。' +
      'DEFERRED / BLOCKED の依存がすべて COMPLETED になった項目を検出する — ' +
      '「着手できる」と「誰も見ていない」は別の報告にする。前者は始める合図、' +
      '後者はまだ必要かを問う合図で、後者の方が価値が高く、かつ気まずい。' +
      'dueForReview の判定も直した: lastReviewedAt が無いだけで常に該当していたため、' +
      '全80件が並んで読む気を失わせていた。作成日をフォールバックにしたので、' +
      '今日書いた項目は「放置」に数えない。全件を永遠に挙げる報告は、二度と開かれない。' +
      '自動実装はしない。Resume Condition の成立確認までが役割。'
  },
  {
    key: 'low_priority_tech_debt',
    title: '低優先度の技術的負債',
    domain: 'maintenance',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason: '安定しているコードを実運用前に無理に Refactor しない。',
    resumeCondition: 'Adapter 追加・重複増大・保守コスト増大・テスト負荷・性能問題のいずれかが発生した時点。',
    source: `${SUPP} §26`,
  },

  // --------------------------------------------------------- hard boundaries
  // §27 HARD SAFETY CONSTITUTION. These record boundaries, not plans. The store
  // refuses to move an entry out of PROHIBITED or OUT_OF_SCOPE, and refuses to
  // turn one into a development task.
  {
    key: 'auto_money_movement',
    title: '資金の自動移動',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。IRIS の自律性が高まっても維持する。',
    risk: '一般的な自律機能の実装によって、この境界が暗黙に解除されることを禁止する。',
    source: `${SUPP} §27`,
  },
  {
    key: 'auto_bank_transfer',
    title: '銀行振込の自動実行',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。',
    source: `${SUPP} §27`,
  },
  {
    key: 'auto_card_payment',
    title: 'カード支払いの自動実行',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。',
    source: `${SUPP} §27`,
  },
  {
    key: 'auto_investment_order',
    title: '投資注文の自動実行',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。',
    source: `${SUPP} §27`,
  },
  {
    key: 'auto_borrowing',
    title: '借入の自動実行',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。',
    source: `${SUPP} §27`,
  },
  {
    key: 'mynumber_persistence',
    title: 'マイナンバーの保存',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。保存しない。',
    source: `${SUPP} §27`,
  },
  {
    key: 'banking_password_persistence',
    title: '銀行パスワードの保存',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。保存しない。',
    source: `${SUPP} §27`,
  },
  {
    key: 'full_pan_persistence',
    title: 'カード番号全桁の保存',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。保存しない。',
    source: `${SUPP} §27`,
  },
  {
    key: 'cvv_persistence',
    title: 'CVV の保存',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'HARD SAFETY CONSTITUTION。保存しない。',
    source: `${SUPP} §27`,
  },
  {
    key: 'line_auto_reply',
    title: 'LINE の自動返信',
    domain: 'safety_boundary',
    status: 'PROHIBITED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason:
      'ユーザーが明示的に方針変更しない限り禁止。「技術的に返信できる」ことを理由に追加しない。',
    source: `${SUPP} §4, §27`,
  },
  {
    key: 'etax_auto_submission',
    title: 'e-Tax の自動申告',
    domain: 'safety_boundary',
    status: 'OUT_OF_SCOPE',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '意図的に対象外。',
    source: `${SUPP} §27`,
  },
  {
    key: 'etax_credential_storage',
    title: 'e-Tax 認証情報の保存',
    domain: 'safety_boundary',
    status: 'OUT_OF_SCOPE',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '意図的に対象外。',
    source: `${SUPP} §27`,
  },
  {
    key: 'myna_portal_credential_storage',
    title: 'マイナポータル認証情報の保存',
    domain: 'safety_boundary',
    status: 'OUT_OF_SCOPE',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '意図的に対象外。',
    source: `${SUPP} §27`,
  },
  {
    key: 'auto_tax_payment',
    title: '納税の自動実行',
    domain: 'safety_boundary',
    status: 'OUT_OF_SCOPE',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '意図的に対象外。',
    source: `${SUPP} §27`,
  },
  {
    key: 'direct_banking_api',
    title: '銀行 API への直接接続',
    domain: 'safety_boundary',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'ユーザーの明示判断なしに実装しない。',
    resumeCondition: '個人が電子決済等代行業者の登録なしに使える読み取り専用 API を、取引のある金融機関が提供したとき。',
    source: `${SUPP} §27, ${V4} §79`,
    notes:
      '見送り(2026-08-20、利用者の判断)。取り下げではない — fi_browser_scraping と違い不変な境界とは衝突しない。' +
      '正規の銀行 API は OAuth でパスワードを保持しないため banking_password_persistence には触れない。塞いでいるのは制度で、' +
      '第三者の接続には電子決済等代行業者の登録と銀行ごとの契約が要り、個人が自分用に取れるものではない（2026-08 時点の理解。規制と提供状況は変わり得る）。' +
      'アグリゲーター経由も検討したが不採用 — 認証情報が事業者側に残り、finance_local_boundary の Local-first と緊張する。' +
      '当面は finance_csv_import で同じ読み取りが達成できており、差は鮮度だけ。その鮮度は finance_gmail_intake で埋める方針とした。'
  },
  {
    key: 'fi_browser_scraping',
    title: '金融機関のブラウザスクレイピング',
    domain: 'safety_boundary',
    status: 'REJECTED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'ユーザーの明示判断なしに実装しない。',
    resumeCondition: 'ユーザーが明示的に採用を決定した時点。',
    source: `${SUPP} §27`,
    notes:
      '取り下げ(2026-08-20、利用者の判断)。既存の不変な境界と両立しない — 自動化には銀行パスワードの保持が要るが、' +
      'banking_password_persistence は PROHIBITED（HARD SAFETY CONSTITUTION）で、PROHIBITED は IMMUTABLE_STATUSES に含まれ IRIS 側から変更できない。' +
      '毎回手でログインする形なら禁止には触れないが、それは自動化ではない。' +
      '代わりに CSV エクスポートの取り込み(finance_csv_import)を実装した — 資格情報を持たず、自動操作もせず、家計の把握はできる。'
  },
  {
    key: 'auto_cloud_financial_backup',
    title: '金融データの自動クラウドバックアップ',
    domain: 'safety_boundary',
    status: 'REJECTED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'ユーザーの明示判断まで保留。追加する場合も Security Boundary を維持する。',
    resumeCondition: 'ユーザーが明示的に採用を決定した時点。',
    source: `${SUPP} §18, §27`,
    notes:
      '取り下げ(2026-08-20、利用者の判断)。finance_local_boundary が常時有効な方針として既に' +
      '「自動クラウドバックアップしない」と述べており、判断待ちに残っていたのは記録の不整合だった。' +
      '調査の過程で本当の問題が出た: バックアップ自体が実質存在せず、2日前の手動スナップショット2件だけで、' +
      'うち1件は当時の DB（現在の1/20のサイズ）のものだった。クラウドを禁じる以上ローカルで取る必要があり、local_backup として実装した。'
  },
  {
    key: 'full_sandbox_migration',
    title: 'Docker / カーネルレベルのサンドボックス移行',
    domain: 'safety_boundary',
    status: 'REJECTED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: 'ユーザーの明示判断なしに実装しない。',
    resumeCondition: null,
    source: `${SUPP} §27`,
    notes:
      '見送り(2026-08-20、利用者の判断)。§27（金融・機密情報の境界）の項目で、「金融機能をやるならアプリ層の約束事では足りない」という文脈のもの。' +
      '金融機能は同日に入った（finance_csv_import / finance_gmail_intake）が、この環境ではコンテナ化が取れない: ' +
      '(1) TCC の許可は起動元プロセスに帰属するため、コンテナの中からカレンダー・マイク・EventKit に届かない。' +
      '音声ヘルパを独立した LaunchAgent にして初めて authorized になった経緯と同じ問題。' +
      '(2) 無人エージェントは別プロセスの Claude Code として利用者の資格情報で動くため、IRIS を隔離しても外側にある（2026-08-20 に実測）。' +
      '(3) finance / backups / worktrees / IrisSpeech.app をマウントで通すことになり、通した分だけ隔離が薄くなる。' +
      '取り下げず見送りにしたのは、利用者が常駐機の購入を予定しているため — Linux なら前提がまるごと変わる。' +
      'この環境で取れる分は local_data_permissions として実装した（ディレクトリ700 / ファイル600）。' +
      'サンドボックスの代わりではないが、持ち運ぶマシンでは効果が大きい。' +
      '取り下げへ移行(2026-08-20)。見送りの再開条件は「常駐機を導入したとき、その OS で判断する」だった。' +
      '利用者が常駐機を macOS（Mac mini 等）にすると回答したため条件は満たされ、答えが決まった — ' +
      'TCC の制約は現在と同じで、コンテナからカレンダー・マイク・EventKit には届かない。' +
      '同時に EventKit・IrisSpeech.app・TCC の知見・署名証明書はそのまま使えるため、移行は同一 OS への引っ越しになる。'
  },

  // ------------------------------------------- reported but not found (audit)
  {
    key: 'pilot_readiness_service',
    title: 'PilotReadinessService',
    domain: 'audit',
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '過去に実装済みと報告されたが、Mac 監査で未確認。存在すると仮定しない。',
    source: `${V4} §3`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },
  {
    key: 'system_health_service',
    title: 'SystemHealthService',
    domain: 'audit',
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'NONE',
    reality: 'PARTIAL',
    priority: 'NONE',
    reason:
      '過去の実装報告は未確認。ただし /api/health は Reliable State で拡張済み（schema バージョン・承認件数を含む）。',
    evidence: ['server/index.ts の /api/health'],
    source: `${V4} §3`,
    notes: '訂正(2026-08-19): その名前のサービスは存在しないが、/api/health が同等の役割を果たしている。完全な不在ではないため PARTIAL。',
  },
  {
    key: 'claude_handoff_builder',
    title: 'ClaudeHandoffBuilder',
    domain: 'audit',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'NONE',
    reason:
      '過去の実装報告は監査で未確認だったが、同等の機能を server/core/handoff.ts として新規実装し実機検証済み。',
    evidence: ['server/core/handoff.ts', 'commit 7bd3323'],
    source: `${V4} §3`,
    notes: 'REPORTED_BUT_NOT_FOUND から、実在する実装へ解決した項目。',
  },
  {
    key: 'workspace_projects',
    title: 'workspace_projects テーブル',
    domain: 'audit',
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason: '過去の実装報告は未確認。Project/Topic 基盤の実装時に改めて設計する。',
    dependencies: ['project_topic_foundation'],
    source: `${V4} §3`,
    notes: '訂正(2026-08-19): 別チャットのダッシュボードで提案された候補であり、完成の報告ではなかった。実装されたと主張された事実がないため REPORTED_BUT_NOT_FOUND は不正確で、単に未実装。',
  },

  // ------------------------------------------------- ambient / 環境センシング
  {
    key: 'apple_speech_analyzer',
    title: 'Apple SpeechAnalyzer による音声入力',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'オンデバイス完結で、外部に出るのは文字列だけ。実機のマイクから ja-JP の確定テキストを取得し、' +
      'HTTP 経由の開始・停止・取り出しまで動作を確認済み。',
    dependencies: [],
    evidence: [
      'swift/iris-speech（SpeechAnalyzer + SpeechTranscriber, progressiveTranscription）',
      'server/services/speech_bridge.ts',
      'scripts/test-speech.ts（34件 + --live 5件）',
      '実機: 44.1kHz → 16kHz 変換、partial→final、stdin EOF での確定終了を確認',
    ],
    source: AMBIENT,
    notes:
      '取り出した文字列を自動でモデルに送る経路は意図的に作っていない。' +
      '常時マイクが自分でプロバイダに話しかける構成は、この設計が避けている唯一の形。' +
      '消費側は context_engine の担当。' +
      '実機で判明: AssetInventory.status(forModules:) と SpeechTranscriber.installedLocales は別の質問に答える。' +
      'ja-JP が installedLocales にあっても status は supported のことがあり、listen 可否は前者で判定すること。' +
      '対応ロケールは30。',
  },
  {
    key: 'speech_helper_launchd_packaging',
    title: '音声ヘルパの launchd 起動と TCC 許可',
    domain: 'ambient',
    status: 'CURRENT',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P1',
    reason:
      '実際に launchd から起動して調査した結果、問題は2つあり、1つ目が2つ目を隠していた。' +
      'いずれも対処済みで、launchd 文脈での probe 完走を確認。',
    dependencies: ['apple_speech_analyzer'],
    evidence: [
      '2026-08-19 実測: launchd から起動 → dyld の getCWD() → open() でハング（main 到達前）',
      '同 実測: ~/Library/Application Support へ移し cwd を /tmp にすると exit=0 で完走',
      'swift/iris-speech/bundle.sh（.app 化 + ad-hoc 署名, bundle id = local.iris.speech）',
      'scripts/install-speech-helper.sh',
      'scripts/test-speech.ts の保護フォルダ検出テスト',
    ],
    source: AMBIENT,
    notes:
      '【問題1・想定外】リポジトリが ~/Downloads にあること自体が原因だった。' +
      'TCC 保護フォルダのため、launchd 文脈では dyld が作業ディレクトリの解決で停止し、' +
      'エラーもクラッシュもログも出ないまま無応答になる。' +
      'マイクとは無関係で、しかも前面のシェルからは完全に正常に見える。' +
      'protectedLocationWarning() で検出し、install:speech で保護外へ配置する。' +
      '【問題2・登録済みの件】バンドル ID がないと TCC 許可が起動元に紐づく。' +
      '.app 化して ad-hoc 署名し、IRIS_SPEECH_BINARY で参照する。' +
      '許可は一度だけ前面から与える必要がある（launchd 下では notDetermined から始まる）。' +
      '【副産物】許可要求に応答がないと無期限に待っていた。45秒で打ち切り、' +
      'microphone_prompt_unanswered として「拒否」とは別に報告する — ' +
      'ユーザーは断ったのではなく、見える形で訊かれていない。' +
      'ad-hoc 署名は再ビルドで identity が変わるため、マイク許可を再度求められることがある。' +
      '【訂正(2026-08-19)】バンドル化では launchd 下のマイク問題は解決していない。実測: 同一バンドル・'
      + '同一 bundleIdentifier (local.iris.speech) で、シェルから probe すると authorized、'
      + 'サービス(launchd)から同じヘルパを probe すると notDetermined。transcriberAvailable も '
      + 'assetStatus も同じなので、差はマイク許可だけ。「probe が完走する」ことを達成と読んでいたが、'
      + 'probe の完走とマイクが使えることは別だった。responsible process への帰属はバンドルIDがあっても'
      + '起動元に従っている。この結果 barge-in は実機で検証できていない。' +
      'なお IRIS_SPEECH_BINARY が未設定で、サービスはリポジトリ内のコピーを使っていた — '
      + '~/Downloads は TCC 保護フォルダで、ad-hoc 署名は別ファイルなら別 identity になる。'
      + '導入先のバンドルを指すよう .env に設定済み。それでも notDetermined は変わらなかった。',
  },
  {
    key: 'context_engine',
    title: 'Context Engine（状況推定の統合層）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '音声・在室・動き・端末状態を束ねて「今の状況」を推定する層。' +
      '信頼できる入力が1つある段階で先に作る。センサーを増やしてから設計すると、' +
      '最初に来たセンサーの都合がスキーマを決めてしまう。',
    dependencies: ['apple_speech_analyzer'],
    evidence: [
      'server/core/context_engine.ts',
      'scripts/test-context.ts（53件）',
      '実機: 発話 → 確定テキスト → presence.occupied / speech.last_utterance の観測を確認',
    ],
    source: AMBIENT,
    notes:
      '現在状態は保存せず、出典・信頼度・観測時刻を持つ観測から導出する。' +
      'unknown は「否定」ではなく「未観測」として明示的に列挙される — ' +
      '在室センサーが何も言っていない家を「無人」と読ませないため。' +
      '信頼度は加齢で下がるのみで、上がることはない。' +
      '較正されていない観測源は上限0.6でキャップし、band（high/medium/low）を併記する。' +
      '音声は uncalibrated として登録した: 初回の実機確認で、意図的に発話していない部屋から' +
      '確定テキストが返ったため。「文字起こしが正確か」と「人がいるか」は別の主張。',
  },
  {
    key: 'context_persistence',
    title: '状況観測の永続化（種別ごとのオプトイン）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'NONE',
    reason:
      '「決定が必要」だったのは方針であって仕組みではない。' +
      '仕組み側を「方針がなければ一切書かない」形にしたので、既定は全種別オフ。' +
      '何を・どれだけ残すかは種別ごとにユーザーが有効化した時点で決まる。',
    dependencies: ['context_engine'],
    evidence: [
      'server/services/context_sqlite.ts',
      'db.ts migration 9（context_retention / context_observations）',
      'scripts/test-context-persistence.ts（48件）',
      '実機: 有効化 → 発話 → 記録 → 再起動 → 復元（0.6 → 0.546、41秒ぶん減衰）を確認',
    ],
    source: AMBIENT,
    notes:
      'context_retention に行がない観測種別は書き込まれない。不在＝オフ。' +
      '有効化には retainMs が必須で、無期限は API 上存在しない — ' +
      '人の行動の無制限なログに、指定漏れで到達できてはならないため。' +
      '無効化は削除ではない（8.5）。残存件数を返し、orphaned() で可視化し、削除は明示的な1呼び出し。' +
      'エクスポート可能。取り出せないデータは、合意した条件より悪い条件で保持していることになる。' +
      '再起動時は有効期限内の観測のみ復元し、元の観測時刻で減衰させる。' +
      '長時間停止後は何も復元されない（それが正しい答え）。',
  },
  {
    key: 'wifi_csi_presence',
    title: 'ESP32 + Wi-Fi CSI（在室・動き検知まで）',
    domain: 'ambient',
    status: 'EXPERIMENTAL',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      '在室と動きの粗い検知までは現実的な範囲。Context Engine の2番目の入力として、' +
      '「ノイズの多いセンサーを統合層が正しく扱えるか」の検証を兼ねる。',
    resumeCondition: 'context_engine が実在し、信頼度が較正済みで扱えること。',
    dependencies: ['context_engine'],
    source: AMBIENT,
    notes:
      '中核機能がこれに依存してはならない。CSI は家具の移動や窓の開閉で特性が変わり、' +
      '較正のドリフトが分類精度より先に問題になる。' +
      '再較正の運用（いつ、誰が、何をもって）を実装より先に決めること。',
  },
  {
    key: 'wifi_csi_localization',
    title: 'Wi-Fi CSI による位置推定・行動分類',
    domain: 'ambient',
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      '「desk_area にいる」水準の位置推定は受信機の複数配置かフィンガープリンティングを要し、' +
      '行動分類は研究段階。在室・動きとは別物として扱う。',
    resumeCondition: 'wifi_csi_presence が実環境で安定し、再較正の運用が確立していること。',
    dependencies: ['wifi_csi_presence'],
    source: AMBIENT,
  },
  {
    key: 'wifi_csi_pose_vitals',
    title: 'Wi-Fi CSI による姿勢推定・バイタル推定',
    domain: 'ambient',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'NONE',
    reason:
      '技術的な難度ではなく、観測範囲の問題。CSI は壁を越えて家全体を受動的に観測するため、' +
      '同意していない同居人・来客も対象になる。さらにバイタル推定は健康情報の推定であり、' +
      '当たっても外れても影響が大きい。ユーザーの明示的な判断なしに着手しない。',
    resumeCondition:
      'ユーザーが、観測対象になりうる人の範囲と、推定値の保存可否について明示的に決定すること。',
    dependencies: ['wifi_csi_localization'],
    source: AMBIENT,
    notes: 'ロードマップ上も中核機能から分離することで合意済み。',
  },
  {
    key: 'ambient_proactive_action',
    title: '推定状況を起点とした先回り動作',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '境界をルールではなくオーケストレータ側で強制した。推定起点の実行（origin=inferred）は ' +
      'EXTERNAL_ACTION と DESTRUCTIVE に到達できない。承認で通すのではなく、拒否する。',
    dependencies: ['context_engine'],
    evidence: [
      'server/core/proactive_service.ts',
      'server/core/orchestrator.ts の FORBIDDEN_FOR_INFERRED',
      'db.ts migration 8（pending_approvals.origin）',
      'scripts/test-proactive.ts（57件）',
      '実機: 発話 → presence 観測 → ルール発火 → 根拠付き提案を確認',
    ],
    source: AMBIENT,
    notes:
      '提案は提案であり、実行ではない。受理して初めて対話が始まり、その対話は origin=inferred として扱われる。' +
      'origin は承認をまたいで保持される（migration 8）— これがないと、' +
      '推定起点の実行が WRITE 承認を1つ通った時点で「推測だったこと」を忘れ、制限が静かに外れる。' +
      '発火ゲートは4つ: 未観測では発火しない / 減衰後の確度で判定する / ' +
      '観測源が矛盾している間は発火しない / クールダウン。' +
      '既定ルールは0件。先回りは既定で付いてくるものではなく、利用者が有効にするもの。',
  },

  // ------------------------------------------------------------- 音声出力
  {
    key: 'voice_output',
    title: '音声出力（TTSProvider・自動フォールバック付き）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'ニューラル優先・オンデバイス最後という順序で、エンジン差し替え可能な形で実装。' +
      'クラウドが落ちても無音にはならない。',
    dependencies: [],
    evidence: [
      'server/services/tts.ts（TtsEngine / TtsService）',
      'swift/iris-speech の voices / speak コマンド',
      'scripts/test-tts.ts（38件）',
      'scripts/audition-voice.ts',
      '実機: Kyoko/Reed/Rocko と OpenAI onyx/ash/sage/nova を再生し比較',
    ],
    source: AMBIENT,
    notes:
      '実測: 同一文でオンデバイス 7.5〜8.4秒、OpenAI 10.3〜12.6秒（再生時間込み）。' +
      '差の約5〜7秒がネットワーク＋合成の待ち時間。' +
      'クラウドエンジンは既定で無効 — chat 用に設定した鍵は、発話の送信への同意ではない。' +
      '順序の既定は google > elevenlabs > openai > device。' +
      '音が既に鳴り始めた後の失敗ではフォールバックしない（§47 をスピーカーに適用）。' +
      '途中まで喋った文を別の声で最初からやり直す方が悪い。' +
      'フォールバック先は声の名前を引き継がない（onyx は他エンジンでは無意味）。' +
      '実機の日本語音声は9種すべて default 品質。Kyoko は compact、他は Eloquence。',
  },
  {
    key: 'tts_streaming_playback',
    title: 'TTS のストリーミング再生',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '解除条件だった「Swift 側で AVAudioPlayerNode に流し込む経路」を実装。' +
      'iris-speech play が stdin から生 PCM を受け取り、届いた分から再生する。',
    dependencies: ['voice_output'],
    evidence: [
      'swift/iris-speech の play コマンド（AVAudioPlayerNode）',
      'server/services/tts.ts の PcmPlayer / streamToPlayer',
      '実測: OpenAI の初音まで 5〜7秒 → 1493ms',
    ],
    source: AMBIENT,
    notes:
      'MP3 ではなく PCM を要求している。生サンプルはデコード不要なので、' +
      '「音声をストリームする」がバイト列のコピーに落ちる。afplay では原理的に不可能だった' +
      '（ファイルを取るので、まさに待ちたくないものを待つことになる）。' +
      '途中キャンセルはパイプを閉じるだけで済む。' +
      'Google だけは一括合成 — ストリーミング合成は gRPC であって REST にはないため、' +
      'streamed: false として報告する。',
  },
  {
    key: 'google_chirp3_hd_tts',
    title: 'Google Cloud TTS (Chirp 3: HD)',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '鍵の設定後に実機で確認。ja-JP の Chirp3-HD 音声が41種見つかり、聴き比べのうえ既定を Enceladus に決定。' +
      '文分割によるパイプライン合成で、朝のブリーフィングの初音が 3639ms → 2074ms。',
    resumeCondition: null,
    dependencies: ['voice_output'],
    evidence: [
      'server/services/tts.ts の GoogleTtsEngine',
      'scripts/compare-tts.ts',
      'scripts/test-tts.ts の splitForSpeech 検証',
      'commit daaa5d2（文分割によるパイプライン合成）',
      '実機: 朝のブリーフィングで初音 3639ms → 2074ms',
      '既定音声 ja-JP-Chirp3-HD-Enceladus（聴き比べで選定）',
    ],
    source: AMBIENT,
    notes:
      '実測(2026-08-19): ja-JP の音声一覧は41種。ハードコードしていたら追随できなかった。' +
      'REST は一括合成のため streamed:false。ストリーミング合成は gRPC 側にしかない。' +
      '音声名はハードコードせず /v1/voices から発見する（ja-JP-Chirp3-HD-… の一覧）。' +
      'ソースに書いた名前は腐る、というのは引退した Anthropic モデル ID で既に学んだ教訓。' +
      'LINEAR16 は WAV で返るため、data チャンクを走査して剥がしている（44バイト固定ではない）。' +
      '【運用上の確定事項(2026-08-19)】' +
      '無料枠は月100万文字で恒常（期限なし）。集中的に聴き比べた一日で977文字だったので、個人利用では事実上使い切れない。' +
      'ElevenLabs の無料枠は月1万文字で、同じ計算だと1日4〜5発で尽きる。常用できるのは Google 側だけ。' +
      'Chirp 3 HD は SSML も pitch / speakingRate も受け付けない。したがって調整レバーは「どの音声を選ぶか」だけで、' +
      '速度や高さの微調整はできない。唯一いじれたのは待ち時間で、それは文分割で片付けた。' +
      'REST の一括合成は文章全体を合成し終えるまで何も返さないため、待ち時間が返答の長さに比例する。' +
      '最も有用な発話（朝のブリーフィング）が最も待たされるという逆転が起きていた。' +
      '文末で分割して2件先行合成し、1つのプレイヤーに順に流す。分割規則が要点で、長すぎれば意味がなく、' +
      '短すぎれば往復コストが上回るうえ、Chirp はリクエスト単位で抑揚を決めるため句を割ると前半と後半が食い違う。' +
      'クラウドエンジンは既定で無効。有効化は明示的なオプトインで、読み上げテキストが端末外に出るため。' +
      'ただし有効化状態は環境変数から起動時に読まれるので、APIで切り替えただけでは再起動で戻る。.env に書くこと。',
  },
  {
    key: 'tts_comparison_harness',
    title: '同一文でのTTS比較（医学用途）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '測れるもの（初音まで・全体・ストリーミング可否）と、聴かなければ分からないもの' +
      '（声質・抑揚・区切り・医学用語の発音）を分けて提示する。',
    dependencies: ['voice_output'],
    evidence: ['scripts/compare-tts.ts', 'npm run tts:compare'],
    source: AMBIENT,
    notes:
      '既定の課題文は用途の難所を狙っている: ギリシャ文字の受容体サブタイプ、カタカナ薬品名、' +
      '一般用途の音声が続けて読みがちな臨床用語。' +
      'プログラムは「β2受容体」が受容体サブタイプとして読まれたか3トークンに割れたかを聞き分けられないので、' +
      '採点はしない。',
  },
  {
    key: 'enhanced_japanese_voices',
    title: '高品質な日本語オンデバイス音声の導入',
    domain: 'ambient',
    status: 'BLOCKED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      'この Mac の日本語音声は9種すべて default 品質で、オフライン時の声が古く聞こえる。' +
      'enhanced / premium はシステム設定からの手動ダウンロードが必要で、API からは導入できない。',
    resumeCondition:
      'システム設定 > アクセシビリティ > 読み上げコンテンツ > システムの声 > 声を管理 から' +
      '日本語の enhanced / premium 音声をダウンロードすること。',
    dependencies: ['voice_output'],
    source: AMBIENT,
    notes: 'iris-speech voices が betterVoicesAvailable でこの状態を報告する。',
  },

  // ------------------------------------- 監査で seed に取り込んだ既存エントリ
  {
    key: 'gemini_free_tier_quota',
    title: 'Gemini 無料枠の優先消費',
    domain: 'provider',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'provider_router が無料枠を最優先で消費し、枯渇時は自動でフェイルオーバーする。' +
      '日次リセットを跨いだら即座に無料側へ戻る。',
    evidence: ['server/core/provider_router.ts', 'scripts/test-routing.ts'],
    source: AUDIT,
    notes:
      'DB にのみ存在し seed になかったため、監査(2026-08-19)で取り込んだ。' +
      'レジスタがソースから再現できない状態は、レジスタ自身が信用できないのと同じ。',
  },
  {
    key: 'review_needs_code_context',
    title: 'レビューにコード本体・diff を含める',
    domain: 'audit',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'development_service が collectCodeContext を呼び、handoff に codeContext を載せている。' +
      'コード込みレビューは実際にシンボリックリンクの脆弱性を検出した。',
    evidence: [
      'server/services/code_context.ts',
      'server/core/development_service.ts:137',
      'scripts/test-code-context.ts',
    ],
    source: AUDIT,
    notes: 'DB にのみ存在し seed になかったため、監査(2026-08-19)で取り込んだ。UNIT_VERIFIED は過小評価だった。',
  },

  // ------------------------------------------------------------------- 予算
  {
    key: 'spending_limits',
    title: '支出上限と常時表示（二重の歯止め）',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason:
      '従量課金のAPIはリアルタイムで請求される。取り返しがつかない失敗は「高い日」ではなく' +
      '「誰も見ていない間に一晩回り続けたループ」であり、ログを読む頃には既に払い終わっている。',
    dependencies: [],
    evidence: [
      'server/core/budget_service.ts',
      'scripts/test-budget.ts（42件）',
      'src/components/Telemetry.tsx の BudgetPanel',
      '実機: 月上限を $0.01 に下げ、有料2社が除外され gemini が応答することを確認',
    ],
    source: AUDIT,
    notes:
      '「二重」は二つの意味で二重にしてある。' +
      '深刻度で二重 — 警告してから停止する。警告は、停止が不意打ちにならないために存在する。' +
      '仕組みで二重 — 呼び出し前の見積もりと、呼び出し後の実請求額。壊れ方が違う: ' +
      '価格表が古ければ見積もりが外れ、後段だけが気づく。' +
      'プロバイダが usage を返さなくなれば後段が盲目になり、前段だけが縛る。' +
      '同じ仕組みを2回見ても、それは1つの仕組みでしかない。' +
      '窓は3つ（1実行・日・月）。1実行の上限が暴走ループの初回を縛る。' +
      '状態は持たない — 支出は run.usage ログから毎回導出する。' +
      'カウンタがないので、再起動もクラッシュループも上限をリセットできない。' +
      '上限到達時はチャットを止めず、無料プロバイダのみに狭める。' +
      '予算切れが失わせるのは能力であって、会話する力ではない。' +
      '価格未登録のモデルは $0 と報告されるため、件数を別に数えて表示する — ' +
      '実際に課金されているのに $0.00 と見せるのは、予算表示が絶対にしてはいけない安心のさせ方。',
  },

  // ------------------------- 監査で seed に取り込んだ、実運用で学んだ項目
  {
    key: 'anthropic_provider_stale_model',
    title: 'Anthropic プロバイダの廃止モデル ID（修正済み）',
    domain: 'models',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason: 'claude-3-5-sonnet-20241022 がハードコードされていた（2025-10 廃止済み）。公式 SDK へ移行し ANTHROPIC_MODEL で切替可能にした。実キーで疎通・ツールループ・承認・拒否の全経路を確認済み。',
    source: AUDIT,
    notes: '同期(2026-08-19): DB にのみ存在していたため seed に取り込んだ。',
    evidence: [
      'server/providers/anthropic.ts',
      'server/services/model_discovery.ts',
    ],
  },
  {
    key: 'listed_vs_usable_models',
    title: 'モデル一覧に載っている ≠ そのエンドポイントで使える',
    domain: 'models',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason: 'gpt-5.5-pro は /v1/models に載るが chat/completions では 404（This is not a chat model）。発見（一覧取得）だけでは不十分で、実際に叩く経路での動作確認が要る。scripts/probe-openai-models.ts で最小プロンプトを送って確認する。gpt-5.3-chat-latest は廃止済みも判明。',
    source: AUDIT,
    notes: '同期(2026-08-19): DB にのみ存在していたため seed に取り込んだ。',
    evidence: [
      'server/services/model_discovery.ts',
      'scripts/probe-openai-models.ts',
    ],
  },
  {
    key: 'prompt_caching',
    title: 'プロンプトキャッシュの導入',
    domain: 'models',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason: '入力が出力の61倍でコストを支配していたため導入。実測で定常状態89%削減（3ターン計51%、初回は書き込み premium で一時的に高い）。ツールループ内でも機能。',
    source: AUDIT,
    notes: '同期(2026-08-19): DB にのみ存在していたため seed に取り込んだ。',
    evidence: [
      'server/providers/anthropic.ts',
      'server/core/usage.ts',
      'scripts/test-usage.ts',
    ],
  },
  {
    key: 'review_timeout_shape',
    title: 'レビューはチャットと時間特性が違う',
    domain: 'development_acceleration',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason: 'チャットの実測往復は2.7〜6.5秒だが、21KBのコード付きハンドオフを Opus がレビューすると120秒を超える。チャット向けのタイムアウトをレビューに流用すると必ず失敗する。レビュー専用に600秒/2回へ分離し、HTTPは202で即時返却して run をポーリングする形に変更。',
    source: AUDIT,
    notes: '同期(2026-08-19): DB にのみ存在していたため seed に取り込んだ。',
    evidence: [
      'server/core/review_service.ts',
      'server/core/resilience.ts',
      'scripts/test-review.ts',
    ],
  },
  {
    key: 'symlink_denylist_bypass',
    title: 'シンボリックリンク経由の機密ファイル流出（修正済み）',
    domain: 'safety_boundary',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason: 'レビュー用コード収集と、ツール用ワークスペースの両方に存在した。拒否リストを要求パスにしか適用しておらず、リポジトリ/ワークスペース内に notes.md -> .env のリンクが1つあれば、名前判定も封じ込め判定も通過して内容が漏れる。workspace 側は read_file（承認なしで自動実行される READ ツール）が使う経路のため影響がより大きい。両方とも実 .env で再現確認し、解決後のパスにも拒否リストを適用して修正。独立レビュー(claude-opus-5)が code_context 側を発見し、workspace 側も同種と予測。予測は正しかった。',
    source: AUDIT,
    notes: '同期(2026-08-19): DB にのみ存在していたため seed に取り込んだ。',
    evidence: [
      'server/tools/workspace.ts',
      'server/services/code_context.ts',
      'scripts/test-tools.ts',
      'scripts/test-code-context.ts',
    ],
  },

  {
    key: 'calendar_eventkit',
    title: 'カレンダー読み取り（EventKit）',
    domain: 'ambient',
    status: 'CURRENT',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '実装・計測とも完了。AppleScript の60〜75秒に対し EventKit の述語検索で10〜60ms。' +
      'ただし常駐サービス経路では TCC が notDetermined のままで、実運用では読めない。',
    resumeCondition:
      'EventKit 経路を使うなら、ヘルパを安定した署名でバンドルすること。' +
      '現在はキャッシュ読み取りで代替しており、日常の運用はそちらで足りている。',
    dependencies: ['apple_speech_analyzer'],
    evidence: [
      'swift/iris-speech の calendar コマンド（EventKit predicateForEvents）',
      'server/services/calendar.ts',
      '実測: open 経由 10〜60ms / AppleScript 実測60〜75秒',
    ],
    source: AUDIT,
    notes:
      'TCC は「責任プロセス」に許可を帰属させる。実測した3通り: ' +
      'このシェルから直接 → 親(claude-code/bash)の writeOnly を継承して拒否。' +
      'open 経由 → 自分が責任プロセスになりフルアクセスを取得、成功。' +
      'launchd 常駐 → notDetermined のまま、プロンプトも出ず即拒否。' +
      'ad-hoc 署名はバイナリのハッシュに紐づくため、リビルドのたびに許可が無効化される。' +
      '実際に、許可を取った直後のリビルドで失われた。' +
      'さらに open 経由で許可が通った状態でも可視カレンダーは0個で、' +
      'iCloud カレンダーが ad-hoc 署名のアプリから見えていない可能性がある。' +
      '「予定0件」と「カレンダー0個」は別物なので、両方報告するようにした。' +
      '性能面の主張は実測で確定しているが、権限面は未解決。' +
      '【解決(2026-08-19)】FDP が維持している .cache/calendar.json を読む方式に切り替えた。' +
      '権限の問題を丸ごと迂回できる — 訊く作業は既に別のものが済ませており、こちらはファイルを読むだけ。' +
      '代わりに鮮度が問題になる。実際このキャッシュは7日間古いまま、毎朝ダッシュボードに描画され続けていた。' +
      '静かに1週間古いカレンダーは、カレンダーが無いより悪い — 見た目に何もおかしくないため。' +
      'そのため stale と ageMs を必ず併記し、観測時刻は「今」ではなく synced_at を使う。' +
      '古いキャッシュは Context Engine 側で自然に期限切れになる。' +
      '【位置づけの変更(2026-08-19)】Google Calendar REST が第一のソースになったため、' +
      'EventKit は3つ目のフォールバックに後退した。TCC の責任プロセス問題は解決していないが、' +
      '解決しなくても日常の読み取りは成立するようになった。安定した署名が手に入るまで、これを直す動機は下がっている。',
  },

  {
    key: 'fdp_calendar_sync_broken',
    title: 'FDP カレンダー同期の停止（Calendar.app 依存）',
    domain: 'proactive',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'NONE',
    reason:
      '調査中に判明。FDP の calendar_sync.py が失敗し続け、キャッシュが7日間古いままだった。' +
      '原因は権限ではなく、Calendar.app が起動していなかったこと（AppleScript は -600 を返す）。',
    dependencies: [],
    evidence: [
      '~/Documents/Founder-Development-Program/calendar_sync.py',
      'Calendar.app 起動後に同期成功、16件取得を確認',
    ],
    source: AUDIT,
    notes:
      'AppleScript 方式は「アプリが起動しているか」に依存する。EventKit にはその依存が無い — ' +
      '速度（60〜75秒 → 10ms）以前に、こちらの方が本質的な違い。' +
      'あわせて launchd ジョブ com.fdp.daily-refresh が exit 78 で停止していたのも修正した。' +
      '原因は plist の StandardOutPath/StandardErrorPath が ~/Documents 配下を指していたこと。' +
      'launchd はジョブ実行前に自分でこれらを開くため、開けないと設定エラーで落ち、' +
      'スクリプトが1行もログを書けないまま終わる。IRIS で踏んだのと同じ壁。' +
      '当初この件を「19日前から権限で死んでいる」と報告したが誤りだった — ' +
      '読んでいたエラーログは7/31の、既に修正済みの問題のものだった。8/12までは正常に動いていた。',
  },

  {
    key: 'daily_focus_in_iris',
    title: '日次フォーカス（FDP 5領域の IRIS 実装）',
    domain: 'proactive',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'FDP ダッシュボードの「領域ごとに1件だけ」を IRIS 側に実装。実データ6領域で動作確認済み。',
    dependencies: ['fdp_daily_dashboard', 'context_engine'],
    evidence: [
      'server/services/fdp_sheets.ts',
      'server/core/daily_focus.ts',
      'scripts/test-focus.ts',
      '実機: 試験・学習・改善・OS・仕事・予定の6領域を実データで表示',
    ],
    source: AUDIT,
    notes:
      'MCP を待たずに実装できた。Sheet は gviz の CSV 出力で引けるため認証が不要 — ' +
      '既存ダッシュボードが既にその方式を使っていた。' +
      '最重要の罠: gviz は存在しないタブ名に対してエラーを返さず「最初のタブ」を返す。' +
      '200 が返り、正しくパースでき、中身だけが別物になる。' +
      'そのタブにしかない列名で検証する（require_col）。既存実装から踏襲。' +
      '選択規則は再導出せず移植した。どれも具体的な失敗から生まれている: ' +
      '期限順だけだと曜日固定の課題が該当曜日に4番目へ沈む（T007）。' +
      '開始予定日フィルタで状態を見ないと、着手済みなのに開始日が未来の課題が消える（T004）。' +
      '改善ログは記録するだけでは反映されず、見せ続けることが強制力の本体。' +
      '追加した規律: 読めなかった領域は「なし」ではなく available:false として報告する。' +
      '「試験がない」と「試験タブが読めなかった」は一覧上で見分けがつかず、意味は正反対。' +
      '【二重実装への対処】FDP 側と IRIS 側で同じ規則の実装が2つある。これは避けられない — ' +
      'Python 側は毎朝動いていて、私が消してよいものではない。避けられるのは「乖離が見えないこと」の方。' +
      'focus:compare が両方を実行し、選択（ID）を比較する。文面ではなく判断を比べる — ' +
      '同じ行が片方では W003、もう片方では 内容 列で表示されるので、文面比較では表示の違いを拾ってしまう。' +
      '規則の正本は FDP 側（today.py）とする。' +
      '実測(2026-08-19): 学習 T005 / OS TSK-010 / 仕事 W003 で3領域とも一致。' +
      '移植時の取りこぼしを1件発見して修正した: EXAM_FOCUS_DAYS を定数として宣言しながら使っていなかった。' +
      '原典では選択を変えず表示だけを変える（「試験モード。学習系は無理に積まない」）。' +
      '使わない定数は、存在しないフィルタがあるように読ませるぶん、書かないより悪い。',
  },

  {
    key: 'focus_divergence_check',
    title: '日次フォーカスの二重実装の乖離検出',
    domain: 'validation',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '同じ選択規則が Python と TypeScript の2箇所にある。統合はできないので、乖離を見えるようにする。',
    dependencies: ['daily_focus_in_iris', 'fdp_daily_dashboard'],
    evidence: ['scripts/compare-focus.ts', '実測: 3領域一致（T005 / TSK-010 / W003）'],
    source: AUDIT,
    notes:
      'register:drift と同じ発想。統合できないものを統合したふりをするより、' +
      'ずれたときに分かる方が安全。' +
      '比較対象は ID のみ。文面を比べると表示の違いを乖離として拾う。' +
      '「比較できなかった」と「一致しなかった」を別の終了コードにしている（2 と 1）— ' +
      'FDP が実行できないことと、規則が食い違っていることは意味が正反対。',
  },

  {
    key: 'irreversible_deadline_lead_time',
    title: '取り返しのつかない締切の先出し',
    domain: 'proactive',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '締切は等価ではない。再挑戦できるものと、逃すと後続ごと消えるものがある。' +
      'IRIS が既にツールに対して持っている「取り返しのつかなさ」の物差しを、日付に当てた。',
    dependencies: ['daily_focus_in_iris'],
    evidence: [
      "server/core/daily_focus.ts の contest() / readContestMarkings()",
      'scripts/test-focus.ts',
      '実測: C011（36日先・不可逆）が C002（2日先・任意）より優先されることを確認',
    ],
    source: AUDIT,
    notes:
      '猶予を不可逆性に比例させる。再エントリーできる締切は14日前から、' +
      '応募自体が消える締切は45日前から出す。' +
      '知る目的は動けることなので、不可逆な締切では2日前に知っても手遅れになりうる。' +
      '実例: C011（未踏エントリー 9/24 13:00必着）を逃すと C012（9/25 本応募・上限800万）が不可能になる。' +
      '判定はシートの既存記法から読む。「必着」「これを逃すと…不可」「⚠️」「※」は' +
      '24行にわたって既に使われている利用者の語彙で、こちらが並行する語彙を作れば2つ保守することになる。' +
      '更新されるのはシートの方。' +
      '誤判定できるので、根拠にした語句を必ず併記する。' +
      '技術的な落とし穴: ⚠️ は U+26A0 + 異体字セレクタ U+FE0F の2コードポイント。' +
      '文字クラス [⚠️※] は片方しか食わず、セレクタが本文側に残る。単位として一致させること。' +
      '既知: シートの ID は C005 が欠番（C001〜C025 で24件）。実害なし。',
  },

  {
    key: 'local_model_inside_finance_boundary',
    title: '金融境界の内側で動くローカルモデル',
    domain: 'models',
    status: 'BLOCKED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'finance_local_boundary により個別の取引はクラウドのモデルに送られない。結果として IRIS は自分の金融データについて考えることができず、集計値しか触れない。ローカルで動くモデルだけが境界の内側にいるため、明細を読ませられる唯一の手段になる。費用を下げる話ではなく、できることが変わる話。Wi-Fi のない場所で唯一動く経路でもある。',
    resumeCondition:
      'メモリ32GB以上の常駐機を入手した時点。現在の作業機は Apple M2 / 8GB で、27B級は4bit量子化しても18GB必要のため載らない。',
    dependencies: ['finance_local_boundary'],
    evidence: [
      'sysctl hw.memsize: 8GB, Apple M2 (2026-08-20 実測)',
      'server/tools/memory.ts の recall は shareableOnly を recall 時点で強制しており、呼び出し側を信用していない',
      'register: finance_local_boundary は CURRENT / DESIGNED / NOT_IMPLEMENTED',
    ],
    source: '2026-08-20 の検討',
    risk:
      '小さいローカルモデルは複数ツールの使い分けで精度が落ちる。IRIS はツール定義込みで約4100トークンのプロンプトを組むオーケストレータであり、ローカルモデルを調整役に据えるのは現実的でない。金融と単純な用件に限る前提で評価すること。',
    notes:
      'Ollama / llama.cpp はいずれも OpenAI 互換の口を持つため、openai_compatible_provider_base_url が入っていれば接続そのものは追加実装なしで済む。',
  },
  {
    key: 'openai_compatible_provider_base_url',
    title: 'OpenAI 互換エンドポイントへの接続（baseURL）',
    domain: 'provider',
    status: 'PLANNED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P3',
    reason:
      'DeepSeek・Qwen(DashScope)・Ollama・llama.cpp はいずれも OpenAI のプロトコルを話す。server/providers/openai.ts は new OpenAI({ apiKey, maxRetries: 0 }) で接続先を固定しているため、baseURL を受け取れるようにするだけで4つとも到達可能になる。これ単体では何も有効化しないが、他の候補すべての前提になる。',
    evidence: [
      'server/providers/openai.ts:31 に baseURL の指定がない',
      'DeepSeek は OpenAI 互換に加えて Anthropic 互換の口も持つ (api.deepseek.com/anthropic)',
    ],
    source: '2026-08-20 の検討',
    risk:
      '接続先を設定で差し替えられるようにすると、鍵と送信先の組み合わせを取り違えたときに気づきにくい。どのベンダーに何を送ったかは run.usage の servedBy で追えるが、baseURL 自体は記録されていない。実装時は describeSettings に接続先を含めること。',
    notes:
      'vendor フィールドは base.ts のコメントどおりレビューの独立性判定に使われるため、互換エンドポイント経由でも実際の学習元ベンダー名を入れること。openai を名乗らせない。',
  },
  {
    key: 'third_vendor_independent_review',
    title: 'レビューの独立性を上げる第4ベンダー',
    domain: 'models',
    status: 'DEFERRED',
    verification: 'NONE',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P4',
    reason:
      'server/providers/base.ts は vendor について「同じベンダーの別モデルは弱い独立性であり、同一視すると独立性を過大評価する」と明記している。DeepSeek や Qwen は学習系統が Gemini・Anthropic・OpenAI のいずれとも異なるため、independent_review_second_model の質を実際に上げられる。',
    resumeCondition:
      'レビューで見落としが続いた場合、または openai_compatible_provider_base_url が入って接続費用がゼロになった時点。',
    dependencies: ['openai_compatible_provider_base_url', 'independent_review_second_model'],
    evidence: [
      'server/providers/base.ts の vendor フィールドのコメント',
      'DeepSeek v4-flash は1ターン約0.11円で、レビュー用途でも費用が問題にならない',
    ],
    source: '2026-08-20 の検討',
    risk:
      'レビューには変更中のコードが渡る。DeepSeek のクラウドに投げる場合、リポジトリの内容が中国企業のサーバに渡ることを承知して選ぶこと。ローカル Qwen ならこの問題はない。',
    notes:
      '急ぐ理由はない。優先度は低い。',
  },

  {
    key: 'inbound_observation_api',
    title: '外部からの観測受け入れ（iPhone / Shortcuts）',
    domain: 'foundation',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      '/api/context は読み取り・履歴・保持設定・書き出しのみで、外部から観測を POST する経路が存在しない' +
      '。iphone_presence が前提として挙げる Endpoint がこれに当たる。運転モード・位置・Quick' +
      ' Capture はすべてこの1本の不在で止まっている。',
    dependencies: ['iphone_presence', 'context_persistence'],
    evidence: [
      '2026-08-21 実測: /api/context に POST 経路なし',
      'iphone_presence の備考「Shortcuts を作る前に、対応 Endpoint が実在するか確認すること」',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      'アクセス制御は 2026-08-21 に導入済みだが、外部から観測を書き込める経路は新しい攻撃面。受け入れる kin' +
      'd を allowlist で限定し、confidence と source を送信側に決めさせないこと。送信側が自' +
      '称した確度をそのまま Context Engine に入れると、確度という概念が壊れる。',
  },
  {
    key: 'driving_mode',
    title: 'Driving Mode',
    domain: 'ambient',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'CarPlay / 車載Bluetooth の接続を起点に ON、切断で OFF。切断イベントを取り逃しても運転中の' +
      'まま固まらないよう TTL を持たせる（旧設計では約90分）。',
    dependencies: ['inbound_observation_api', 'voice_policy_by_context'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      '運転中だと誤認したまま復帰しないこと。TTL は保険であって、切断検知の代わりではない。',
  },
  {
    key: 'location_context',
    title: '位置情報の受け入れと保持境界',
    domain: 'ambient',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '緯度・経度・精度・速度を Shortcuts から受け取る。最新のみを Ephemeral に保持し、長期の移動履歴' +
      'を無制限に溜めない。TTL を持たせる。',
    dependencies: ['inbound_observation_api', 'context_persistence'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      '位置履歴は本人の生活の完全な記録になる。保持しないことを既定にし、保持するなら context_persistenc' +
      'e の種別ごとオプトインに従う。',
  },
  {
    key: 'navigation_handoff',
    title: 'ナビアプリへの引き渡し',
    domain: 'action_layer',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '目的地を渡してナビアプリを開くための URL を生成する。IRIS が経路案内そのものを行うわけではない。',
    dependencies: ['departure_eta'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'voice_policy_by_context',
    title: '状況に応じた応答の長さと形式',
    domain: 'voice',
    status: 'PLANNED',
    reality: 'PARTIAL',
    priority: 'P2',
    reason:
      '声で聞かれたターンを話し言葉で返す仕組みは 2026-08-20 に実装済み（ReplyChannel）。運転中の超' +
      '短文（旧設計で80文字程度）はこれに値を1つ足すことで実現できる。視覚操作を要求しないこと、低重要度を読み上げないこ' +
      'とが未着手のため PARTIAL。',
    dependencies: ['attention_policy'],
    evidence: [
      'server/core/orchestrator.ts の ReplyChannel',
      'server/config.ts の spokenInstruction',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'conversation_topic_stack',
    title: '話題の退避と復帰',
    domain: 'ambient',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '会話中に一時的に逸れても「さっきの話に戻って」で前の話題へ戻れること。project_topic_foundatio' +
      'n は話題のラベル付けであって、会話上のスタックではない。',
    evidence: [
      '2026-08-21 コード検索: topicStack / resumeTopic に該当なし',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'attention_severity',
    title: 'Attention の重要度軸',
    domain: 'proactive',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '「どれだけ重要か」と「だからどうするか」は別の問いなので、両方持つ。この項目が重要度（CRITICAL / IMPO' +
      'RTANT / USEFUL / PASSIVE / SILENT 相当）を判定し、attention_policy' +
      ' がそれと状況から行動を決める。同じ CRITICAL でも、運転中なら音声のみ、就寝中なら SURFACE_LAT' +
      'ER になる。',
    dependencies: ['attention_policy'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    notes:
      '旧設計に5段階があったとされるが、2026-08-21 のコード検索では該当する enum が見つからず、実在の証拠' +
      'は取れていない。利用者の判断により、旧設計の復元ではなく新規に決め直す。',
  },
  {
    key: 'notification_dedupe',
    title: '通知の重複抑制とクールダウン',
    domain: 'proactive',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      '同じことを何度も言わない。dedupe key で同一性を判定し、状態が意味のある水準で変化した時だけ再通知する。こ' +
      'れが無いと Attention Policy は「賢い通知」ではなく「同じことを繰り返す通知」になる。',
    dependencies: ['attention_policy'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    notes:
      'finance_import_idempotency は取り込みの重複判定であって別物。あちらは「同じ取引を二重に記' +
      '録しない」、こちらは「同じ通知を二度鳴らさない」。',
  },
  {
    key: 'attention_aggregation',
    title: '領域横断の通知集約',
    domain: 'proactive',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '交通遅延・資金不足・重要連絡が同時に起きたとき、3件鳴らさず優先順位をつけた要約にまとめる。',
    dependencies: ['attention_severity', 'notification_dedupe'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'communication_lifecycle',
    title: '通信の状態遷移と未処理の追跡',
    domain: 'communication',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'unseen → seen → acknowledged → handled。返信や提出が必要なまま放置されている連' +
      '絡を取りこぼさないための状態。important_communication_engine には分類の定義はあるが遷' +
      '移が無い。',
    dependencies: ['important_communication_engine'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    notes:
      'LINE について: line_auto_reply は PROHIBITED だが、読む・重要度を判定する・「返信' +
      'が必要だ」と知らせることは禁止対象ではない。この境界を明示的に残す。',
  },
  {
    key: 'google_unified_oauth',
    title: 'Google 認証の一本化',
    domain: 'google_workspace',
    status: 'PLANNED',
    reality: 'PARTIAL',
    priority: 'P2',
    reason:
      'Gmail は google_oauth.ts の GOOGLE_SERVICE_SCOPES、Calendar は' +
      ' oauth_provider.ts（MCP 経由）と、現状 Google の認証経路が2本ある。サービス別スコープ' +
      'の表は用意されているが gmail しか登録されていない。Tasks / Drive を足す前に一本化しないと、経路' +
      'が4本になる。',
    dependencies: ['google_tasks', 'google_drive'],
    evidence: [
      '2026-08-21 実測: GOOGLE_SERVICE_SCOPES に gmail のみ',
      'server/services/oauth_provider.ts が calendar を別実装で処理',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'gmail_general_intake',
    title: '一般の重要連絡としての Gmail 読取',
    domain: 'google_workspace',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'finance_gmail_intake は金融メール専用。授業・提出・予定変更などの一般の重要連絡を読む経路が別途' +
      '要る。',
    dependencies: ['important_communication_engine', 'google_unified_oauth'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'free_to_spend_confirmed',
    title: 'Confirmed Free-to-Spend',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '確定した銀行残高と確定した支払だけから出す「今、安全に使える金額」。推計を混ぜない。',
    dependencies: ['finance_source_of_truth', 'cash_flow_forecast'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'free_to_spend_estimated',
    title: 'Estimated Free-to-Spend',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'Pending 取引や予定値を含む推計値。Confirmed とは別の数として提示し、同じ画面に出す場合もどちらがど' +
      'ちらか分かる形にする。',
    dependencies: ['free_to_spend_confirmed', 'finance_pending_confirmed_model'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'card_statement_model',
    title: '確定請求額のモデル',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '個別の利用明細とは別に「次回確定請求額」を保持する。明細の合計と確定請求額は同じとは限らない。',
    dependencies: ['finance_pending_confirmed_model'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'statement_double_count_guard',
    title: '確定請求額と個別明細の二重計上防止',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      '確定請求額がある期間の個別カード明細を、将来の引落として再び加算しない。これが無い残高予測は実際より減った数字を出す' +
      '。金銭の誤りは他の誤りと重みが違う。',
    dependencies: ['card_statement_model', 'cash_flow_forecast'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      '二重計上は「少なめに見える」方向に外れるため、安全側の誤りに見えてしまう。実際には不要な不足警告を出し続け、警告その' +
      'ものが信用されなくなる。',
  },
  {
    key: 'temporary_shortfall',
    title: '一時的な資金不足の検出',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '月末の残高が黒字でも、途中のカード引落日に一時的にマイナスになる場合がある。月次の集計だけを見ていると検出できない。',
    dependencies: ['cash_flow_forecast', 'card_statement_model'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'income_source_separation',
    title: '収入源の分離',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '親からの支援を給与所得に混ぜない。予定収入と実際の入金を区別する。給与日を推測しない。税の判定に直接効くため、金額を' +
      '足す前に出所を分ける。',
    dependencies: ['finance_source_of_truth'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'finance_source_of_truth',
    title: '金融データの正本境界',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      '銀行残高・CSV 取引・Gmail の pending・確定請求額・税の給与記録が、それぞれ何の正本かを定める。同じ' +
      '支払が複数の経路から入ってくるため、どれを事実とするかを先に決めないと二重計上と欠落が同時に起きる。',
    dependencies: ['finance_pending_confirmed_model'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'tax_rule_registry',
    title: '税ルールの年度別レジストリ',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '年度ごとの公式ルールを記録し、コードに埋め込まない。改正されたときに何を直すべきかが分かる形にする。',
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    notes:
      'tax_maintenance は「勝手に高度な Tax Case へ拡張しない」という保留であって、既存機能の凍結' +
      'ではない。この目録は現状を記録するものであり、拡張の提案ではない。',
  },
  {
    key: 'tax_rule_provenance',
    title: '税ルールの出典保持',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '法令・国税庁等の出典を rule record に持たせる。根拠を持たないルールを IRIS が作らないこと。',
    dependencies: ['tax_rule_registry'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      '出典が無いルールは、もっともらしい誤りとして残り続ける。金銭と法令が絡む領域で最も避けたい形。',
  },
  {
    key: 'tax_scope_aware_assessment',
    title: '評価範囲を明示した税判定',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '「確定申告は不要」と断定せず、どの給与所得ルールの範囲で評価したのかを添える。評価していない条件を、評価して問題なし' +
      'と区別できるようにする。',
    dependencies: ['tax_rule_registry'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'tax_multiple_employers',
    title: '複数勤務先の給与合算',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '1社・2社・3社以上を扱い、従たる給与をすべて合算する。主たる給与先が不明なら推測しない。',
    dependencies: ['tax_scope_aware_assessment', 'income_source_separation'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'tax_safe_failure',
    title: '税判定の安全停止',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      'RULE_UNVERIFIED / NEEDS_MORE_INFORMATION / DATA_INCONSISTE' +
      'NT で明示的に止まる。情報が足りないときに答えを出さないことを、失敗ではなく正しい結果として扱う。',
    dependencies: ['tax_scope_aware_assessment'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'tax_document_checklist',
    title: '税務書類のチェックリスト',
    domain: 'finance',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '源泉徴収票など、何が揃っていて何が足りないかを示す準備支援。判定ではなく準備の話。',
    dependencies: ['tax_multiple_employers'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'context_health',
    title: 'セッションの文脈健全性',
    domain: 'foundation',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '長大なセッションで文脈が劣化していることを検出する。劣化に気づかないまま続けると、古い前提のまま新しい決定をする。',
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'handoff_staleness',
    title: 'ハンドオフの陳腐化検出',
    domain: 'development_acceleration',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '正本の状態が更新された後に、古い handoff を使わないための hash / version 管理。',
    dependencies: ['development_task_handoff'],
    evidence: [
      '2026-08-21 コード検索: diffHash 相当なし',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'stale_review_guard',
    title: 'レビュー結果の陳腐化防止',
    domain: 'audit',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      'レビュー後にコードが変わったら、そのレビュー結果を有効なものとして扱わない。現行の reviewAttempts は' +
      '通信の再試行であって、これとは別物。',
    dependencies: ['independent_review_second_model'],
    evidence: [
      '2026-08-21 コード検索: diffHash / staleReview に該当なし',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      '通ったはずのレビューが根拠として残り続けると、独立レビューという仕組み自体が「以前は問題なかった」の証明書に変わる。',
  },
  {
    key: 'review_loop_cap',
    title: '自動レビュー往復の上限',
    domain: 'audit',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'レビュー → 修正 → 再レビューが終わらない場合に止める。',
    dependencies: ['independent_review_second_model'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'exec_content_verification',
    title: '検証済み内容と実行内容の同一性',
    domain: 'safety_boundary',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P1',
    reason:
      '検証した内容と実際に実行される内容が差し替わらないことを保証する。コーディングエージェントは既に動いているため、これ' +
      'は計画中の機能の空白とは意味が違う。',
    dependencies: ['coding_agent_invocation'],
    evidence: [
      '2026-08-21 コード検索: TOCTOU 対策に該当なし',
      'coding_agent_invocation は VERIFIED_PRESENT で稼働中',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
    risk:
      'パスやスクリプトの内容が検証後に書き換わると、承認した内容とは別のものが動く。',
  },
  {
    key: 'pre_restore_snapshot',
    title: '復元前の緊急退避',
    domain: 'foundation',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      'Restore を実行する前に現在の状態を退避する。local_backup は取得と検証までで、復元の手順が書かれ' +
      'ていない。復元は最も緊張する操作であり、その直前が最も無防備。',
    dependencies: ['local_backup'],
    evidence: [
      '2026-08-21 コード検索: preRestore / emergencySnapshot に該当なし',
    ],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'life_hub_surfaces',
    title: 'Life Hub の各面',
    domain: 'surfaces',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '今日の予定・次の出発・優先タスク・資金の概況・重要連絡、および必要時に開く副パネル。バックエンドの機能が登録されてい' +
      'ても「利用者が何を見るか」は別に決める必要がある。',
    dependencies: ['daily_focus_in_iris', 'departure_eta', 'free_to_spend_confirmed', 'important_communication_engine'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'life_plan_import',
    title: '長期予定の取り込み',
    domain: 'personal_state',
    status: 'PLANNED',
    reality: 'NOT_IMPLEMENTED',
    priority: 'P2',
    reason:
      '年間予定・学務・バイト・キャリア・長期目標を構造化して正本へ統合する受け皿。',
    dependencies: ['project_topic_foundation'],
    source: '2026-08-21 の設計監査（過去設計78項目との照合）',
  },
  {
    key: 'coding_agent_dispatch_tool',
    title: 'IRIS からコーディングエージェントを起動する',
    domain: 'development',
    status: 'COMPLETED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'start_coding_agent（WRITE）。タスク作成と起動を1回の呼び出しで行う。2回に分けると1つの判断に対して承認が2回必要にな' +
      'り、無くしたかったボタンがそのまま残るため。従来は起動が HTTP のみで、IRIS はタスクと引き継ぎ書を用意できても投げら' +
      'れなかった。',
    verification: 'RUNTIME_VERIFIED',
    // Not a dependency on the grant: the tool works without one, it simply
    // asks. The grant depends on the tool, and stating it both ways was a
    // cycle — caught by test-register.ts before it reached the register.
    dependencies: ['coding_agent_invocation'],
    evidence: [
      '2026-08-21 実測: 委任なしでチャットから依頼 → requires_approval / start_coding_agent / WRITE で停止',
      '2026-08-21 実測: 委任あり → 承認を挟まず実行し、未コミット変更のため dirty_tree で正しく拒否',
    ],
    source: '2026-08-21 「イーリスに頼んだら claude や codex に割り振ってほしい」',
  },
  {
    key: 'agent_delegation_grant',
    title: '事前承認（委任）',
    domain: 'safety',
    status: 'COMPLETED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '毎回承認を押すのは「頼んだらやってくれる」ではないため、承認を前もって与える形にした。承認境界の不変条件（リスク段階' +
      'が決める／ツールの自己申告では免除されない）は変更していない。変わったのは「誰がいつ承認するか」。範囲・日次上限・同' +
      '時実行数・期限を持ち、推定による実行では使えず、使用のたびに delegation.used を発火する。読めない値（NaN の上限、解' +
      '釈できない期限、取得できない使用額）はすべて拒否側に倒す。',
    verification: 'RUNTIME_VERIFIED',
    dependencies: ['coding_agent_dispatch_tool'],
    evidence: [
      '2026-08-21 scripts/test-delegation.ts 39件',
      '2026-08-21 実測: POST /api/delegation → 承認なしで実行、DELETE → 承認を要求',
      '2026-08-21 未計測の実行は1回あたり上限額として計上（ゼロ扱いにしない）',
    ],
    source: '2026-08-21 「ジャービスにトニーはわざわざ叩いてない」',
  },
  {
    key: 'codex_agent_backend',
    title: 'Codex を第2のコーディングエージェントに',
    domain: 'development',
    // COMPLETED は「検証済みかつ実在確認済み」でなければ名乗れない（登録簿の規則）。
    // 部品はそれぞれ実測したが、無人実行の通しがまだなのでこの状態に置く。
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'UNIT_VERIFIED',
    reality: 'PARTIAL',
    priority: 'P2',
    reason:
      'codex exec --json -s workspace-write。費用は ~/.codex/sessions の rollout から実測する。' +
      'PARTIAL は実際の無人実行をまだ完走させていないため。引数・サンドボックス・費用計測は個別に検証済みだが、' +
      '通しで1回動かすまでは VERIFIED_PRESENT にしない。',
    dependencies: ['coding_agent_dispatch_tool'],
    evidence: [
      '2026-08-21 実測: codex sandbox -s workspace-write で worktree 内の git add / commit が成功',
      '2026-08-21 実測: 同サンドボックスで curl https://example.com は接続不成立（コマンドはネットワークに出られない）',
      '2026-08-21 実測: readCodexTranscript が実セッションを課金（sol $59.07 / terra $42.31 / luna $0.14）',
      '2026-08-21 未検証: 無人実行の通し1回',
    ],
    source: '2026-08-21 「どっちもやって」',
  },
  {
    key: 'agent_push_transport_ban',
    title: 'push の禁止をトランスポート層で行う',
    domain: 'safety',
    status: 'COMPLETED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '従来の --disallowedTools Bash(git push*) はコマンド行の文字列一致で、git -c x=y push・スクリプト経由・別名など書き' +
      '方を変えれば一致しない。子プロセスの環境に GIT_ALLOW_PROTOCOL=file を置き、git 自身のトランスポート判定で止める。' +
      'どのエージェントでも、どんな書き方でも通らない。Codex には --disallowedTools が無く、フラグでは表現できなかったこと' +
      'が、既存の禁止が見た目より弱いことを明らかにした。従来のフラグも二重の防御として残している。',
    verification: 'RUNTIME_VERIFIED',
    dependencies: ['coding_agent_invocation'],
    evidence: [
      '2026-08-21 実測: 制限なし → remote: Repository not found（GitHub に到達）',
      "2026-08-21 実測: GIT_ALLOW_PROTOCOL=file → fatal: transport 'https' not allowed（接続前に停止）",
      '2026-08-21 scripts/test-agent-runner.ts が子プロセス環境の鍵集合を固定',
    ],
    source: '2026-08-21 Codex 対応の副産物',
  },
  {
    key: 'third_party_data_boundary',
    title: '他人のデータの境界',
    domain: 'safety',
    status: 'CURRENT',
    verification: 'DESIGNED',
    reality: 'PARTIAL',
    priority: 'P0',
    reason:
      '境界を「プライベートかどうか」ではなく「利用者本人のものか、他人のものか」で引く。利用者は自分について何を渡すか決められるが、' +
      'そこに写り込む他人の分は決められない。\n\n' +
      '本人のもの（制限なし）: 端末の状態、バッテリー、稼働アプリ、ディスク、ネットワーク、予定の時刻と場所、体調、支出の集計、' +
      'リポジトリとセッションの状態。\n\n' +
      '他人が写り込むもの（読んで判定して知らせるまで。保存と外部送信をしない）: 予定の相手の名前、メッセージ本文、メールの差出人と本文、' +
      '連絡先、通話履歴。\n\n' +
      'この線は `finance_local_boundary` と同じ性質だが対象が違う。あちらは「利用者の金銭は端末外に出さない」で、' +
      'こちらは「他人の情報は保持しない」。前者は本人の希望で緩められるが、後者は本人が同意する立場にない。',
    dependencies: ['finance_local_boundary'],
    evidence: [
      '2026-08-21 実例: テストデータに第三者の実名と予定時刻が22箇所固定されていた（`けやき台 面談` へ置換済み）',
      '2026-08-21 実例: 音声の分岐規則「名指しされたものだけが要求になる」は同じ理由で存在する',
      '2026-08-22 未実装: メッセージ・メール・連絡先の取り込みは行っていない。境界が先に決まった状態',
    ],
    notes:
      'PARTIAL は、線が引かれたが強制する仕組みが無いため。`finance_local_boundary` は countLocalOnly による関門を持つが、' +
      '他人のデータには同等のものが無い。取り込みを実装する時点で、同じ形の関門を先に作る。',
    source: '2026-08-22 「プライベートすぎることを除いた全てを把握させたい」への境界設計',
  },
  // ------------------------------------- 2026-08-22 常駐面に足した4本の経路
  {
    key: 'weather_via_shortcut',
    title: '天気（ショートカット経由）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '帯の右端に現在の天気を出す。macOS は予報を API として渡さない。`~/Library/Weather/weather-data.db` は現在の天気を持つが、' +
      '`model` 列は 623 バイトの非公開バイナリで、8 バイトの double が2つ（時刻）だけ解け、残りは解けない。' +
      '解析すれば OS 更新のたびに壊れる読み取り器になるため、Apple が維持する経路であるショートカットを呼ぶ。',
    dependencies: [],
    evidence: [
      '2026-08-22 実測: `shortcuts run` は stdin が閉じるまで開始しない。child.stdin.end() 無しで45秒待って無出力、有りで2.0秒',
      '2026-08-22 実測: 3回連続 1〜2秒で `今日の気温は26℃、やや曇りです。`',
      'server/services/weather.ts / scripts なし（実機のショートカットに依存）',
    ],
    notes:
      '弱点は、依存先がリポジトリの外にあること。利用者が手で作った「天気テキスト」が消えれば止まる。' +
      'そのため欠測は空欄にせずショートカット名を挙げて報告する。予報が無いこととショートカットが無いことは外から見分けがつかず、' +
      '待って直るのは片方だけ。失敗のキャッシュは60秒（成功は15分）で、一瞬の失敗が原因の消えた後も居座らないようにしている。',
    source: '2026-08-22 「天気とかこのmacから持って来れない？」',
  },
  {
    key: 'travel_time_mapkit',
    title: '次の予定までの移動時間（MapKit）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '予定の時刻だけを読み上げるのは日記の音読で、実際の問いは「そろそろ出るべきか」。それは渋滞に依存し、カレンダーにも台帳にも無い。' +
      'サーバがカレンダーと場所表から行き先だけを答え、経路は HUD 内の MapKit が測る。位置情報の許可はアプリ束に属するため、' +
      'IRIS のうち束であるのはメニューバーアプリだけ。',
    dependencies: ['third_party_data_boundary'],
    evidence: [
      '2026-08-22 実測: ショートカットの `移動時間を取得` は macOS で何も返さない。住所・現在地→現在地・車・徒歩・CLI・アプリの▶、すべて空',
      '2026-08-22 実測: 帯に `移動には 4分 かかります。` が出た（MapKit calculateETA）',
      'menubar/Travel.swift / server/services/travel.ts / GET /api/travel/next',
    ],
    notes:
      '住所表は .iris/places.json に置き、git 管理外。ひとりの人間の定期的な行き先であって、ソースと一緒に配るものではない。\n\n' +
      '3時間以内の予定にしか測らない。明後日の渋滞は知りようがなく、誰も確かめられない数字が一日中帯に載ることになる。\n\n' +
      '署名の罠を記録する。`IRIS HUD.new` にビルドして移していたため ad-hoc 署名の識別子が一時ファイル名になり、Info.plist が署名に含まれず、' +
      '**位置情報のダイアログが一度も出なかった**。menubar/install.sh がビルド→設置→署名の順を固定する。',
    source: '2026-08-22 「現在地からの時間を取得してほしい」',
  },
  {
    key: 'claude_allowance_relay',
    title: 'Claude の週次上限の中継と自動更新',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'Codex の週次残量は帯にあり、Claude のものは無かった。トークン数は記録から数えられるが、割合には上限が要り、上限はこの端末に無い。' +
      '`rateLimits` は記録に欄としては存在し、479 箇所すべて null。実数はステータス行フックに渡るペイロードにしか無い。',
    dependencies: [],
    evidence: [
      '2026-08-22 全文検索: ~/.claude 以下と ~/.claude.json に上限の実数は無い（等級名 default_claude_max_5x と販促文のみ）',
      '2026-08-22 実測: デスクトップアプリは statusLine を実行しない（再起動後6時間半、ファイル無変化）。claude -p も実行しない',
      '2026-08-22 実測: 更新1回 $0.023 / 約6秒。7日枠は2回連続で叩いても動かず、5時間枠が約0.5pt',
      'server/services/claude_usage.ts / server/services/allowance_refresh.ts / POST /api/usage/refresh',
    ],
    notes:
      '「メーターが測る対象を消費する」ことを理由に自動化を退けたが、それは量を測らずに言った反対だった。実測で摂動は読み取り分解能より下。\n\n' +
      '通すまでに3つ潰した。expect は TUI が描画状態に到達せずセッションすら作られない。この機体の screen は 4.00.03 で即座に落ちる。' +
      'Terminal.app を AppleScript で駆動するとステータス行は走るが打鍵が届かず、osascript が固まり窓が残る。' +
      '`script -q /dev/null claude "<prompt>"` が通る。プロンプトを引数で渡せば打鍵が要らない。\n\n' +
      '罠が2つ。信頼済みでないディレクトリでは「このフォルダを信頼しますか」で、来ない打鍵を待ち続ける。' +
      'そして `CLAUDE_CODE_CHILD_SESSION` を継承すると**費用は払い、質問には答え、何も書かない**。' +
      'stdio: ignore のままだと「遅いだけ」と区別がつかない。\n\n' +
      '定期実行はしない。ダッシュボードを開いたときに1時間以上古ければ動く。誰も見ていない端末が、誰も読まない数字のために払う必要はない。',
    source: '2026-08-22 「claudeのセッション使用量を表示する方法があるらしい」',
  },
  {
    key: 'dashboard_task_visibility',
    title: 'ダッシュボードのタスク一覧と週次ゲージ',
    domain: 'ambient',
    status: 'REAL_WORLD_VERIFICATION_REQUIRED',
    verification: 'IMPLEMENTED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '帯が「完了 14/18」と言い続けたが、無関係な2プロジェクトの合計は、どちらの都合とも関係なく動き、手の打ちようがない。' +
      '3回同じ不満を受けた。タスクごとの状態と、止まっている理由と、週次残量の円形ゲージ2つをダッシュボードに置いた。',
    dependencies: ['claude_allowance_relay'],
    evidence: [
      'menubar/IrisMenuBar.swift: タスク一覧（停止→進行中→未着手の順、完了は件数）、sessionDial 2つ',
      '2026-08-22 Codex に数値仕様を依頼し採用（外周0.46D・目盛環0.43D・トラックと弧0.37D・目盛36本）',
    ],
    notes:
      'REAL_WORLD_VERIFICATION_REQUIRED である理由は、**私が描画結果を見ていない**こと。コンパイルと設置は済み、データ経路は curl で確認したが、' +
      'ダッシュボードを開いた画面を確認していない。0% と未取得の描き分け（実線トラック対 破線）が実際に区別できるかは未検証。',
    source: '2026-08-22 「それぞれのタスクの進行度を書きたいだけ」',
  },
  // ------------------------------ 2026-08-22 後半：無人運転に必要だったもの
  {
    key: 'repo_backup',
    title: 'リポジトリの自動退避',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      'リモートを作った当日に、それが答えるはずの問いが立った。リモートは誰かが押したものしか持たないので、' +
      '午後4時に円盤が死ねば午後が消える。15分ごとと起動直後に、現在のブランチを押す。',
    dependencies: [],
    evidence: [
      'server/services/repo_backup.ts / GET・POST /api/backup/repo',
      '2026-08-22 実証: リモートを存在しないリポジトリに向けて失敗経路を確認。' +
        '「remote: Repository not found」が帯に到達し、手元にしかないコミット数も出た',
      '2026-08-22 実測: 自分のコミットを自分で押した（lastPushAt が記録される）',
    ],
    notes:
      '判断はしない。コミットは既に存在するものを送るだけで、審査点はコミットの側にある。それが自動化を安全にしている。\n\n' +
      'エージェントの push 禁止は無傷。委任エージェントは GIT_ALLOW_PROTOCOL=file で転送層で止まる。これはサーバ自身の環境で動く。\n\n' +
      '作り込んだのは失敗の側。止まったバックアップは何も書かず、何も出ていない画面は動いているものと見分けがつかない。' +
      'エラーは verbatim で残し、承認待ちの次に高い優先度で帯に出す。',
    source: '2026-08-22 「自動バックアップは？」',
  },
  {
    key: 'allowance_refresh',
    title: '使用量の自動取得',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '上限の実数はステータス行フックのペイロードにしか無く、それは端末の TUI が描画されたときしか走らない。' +
      '帯だけ見ている人の前で数字が69分間止まっていた。帯の心拍（30秒ごと）を合図に、5分以上古ければ取り直す。',
    dependencies: ['claude_allowance_relay'],
    evidence: [
      'server/services/allowance_refresh.ts / GET・POST /api/usage/refresh',
      '2026-08-22 実測: 温まった状態で1回 $0.023 / 約6秒。7日枠は2回連続でも動かず、5時間枠が約0.5pt',
      '2026-08-22 実測: script(1) の擬似端末 + プロンプト引数で通る。expect・screen・AppleScript は通らない',
    ],
    notes:
      '「メーターが測る対象を消費する」ことを理由に自動化を退けたが、それは量を測らずに言った反対だった。実測で摂動は分解能より下。\n\n' +
      '罠が3つ。信頼済みでないディレクトリでは「このフォルダを信頼しますか」で来ない打鍵を待つ。' +
      '`CLAUDE_CODE_CHILD_SESSION` を継承すると**費用は払い、質問には答え、何も書かない**。' +
      '`ANTHROPIC_API_KEY` があると「このAPIキーを使うか」で止まる — しかも測りたいのは定額契約の残量なので、' +
      '渡していたら別のメーターを測っていた。接頭辞での除外では2つ目が捕まらないため、環境をゼロから組み立てる。\n\n' +
      '完了判定も一度間違えた。ステータス行は画面が描かれた瞬間に走るので、往復前のペイロードには rate_limits が無い。' +
      '「ファイルが変わったら完了」だと1秒で殺して、何も答えていないペイロードを成功として報告する。',
    source: '2026-08-22 「usageだけ5分ごとに更新できたりする？」',
  },
  {
    key: 'exam_countdown',
    title: '次の試験までの日数',
    domain: 'personal_state',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P3',
    reason:
      '帯のほぼ全部は「変わること」で場所を得ている。これは変わらないことで得る — ' +
      '試験日を調べるのは、それが遠くなくなった日ではないため。',
    dependencies: [],
    evidence: [
      'server/services/exam.ts / GET /api/exam/next（1時間キャッシュ）',
      '2026-08-22 実測: {"title":"神経科学本試験","date":"2026-08-24","days":2,"after":4}',
    ],
    notes:
      '日付ではなく日数。問いは「いつか」ではなく「あとどれだけか」で、日付だと毎回引き算させる。\n\n' +
      '再試・追試は数えない。カレンダーに数ヶ月先まで枠として入っていて、受けるか分からない再試までの' +
      'カウントダウンを毎日見せるのは、正確でも有益でもない。\n\n' +
      '未検証: 単体テストが無い。分岐は3つ（該当なし・当日・再試除外）ある。' +
      'ベンチマークで両エージェントが書いたが、どちらの枝も未取り込み。',
    source: '2026-08-22 「直近の試験までの日にちを常に出しておいてほしい」',
  },
  {
    key: 'local_code_signing',
    title: 'HUD の署名を安定させる',
    domain: 'foundation',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      'ad-hoc 署名には証明書が無いので、macOS は実行ファイルの指紋で同一性を判断する。' +
      'コードを変えるたびに別のアプリになり、位置情報の許可を毎回聞かれる。作業中は数分おきのダイアログになる。',
    dependencies: ['travel_time_mapkit'],
    evidence: [
      'menubar/signing-setup.sh / menubar/install.sh',
      '2026-08-22 実測: 同一ソースの2回のビルドは CDHash 一致、定数を1つ変えると不一致',
      '2026-08-22 実測: 自己署名後の designated requirement は identifier + certificate root で、再ビルドしても不変',
    ],
    notes:
      'ログインキーチェーンではない。そこに鍵を置くと codesign に使わせるのにログインパスワードが要る。' +
      'この専用キーチェーンは自己署名の証明書1枚しか持たないので、パスワードはスクリプトに平文で書いてある。\n\n' +
      '証明書をルートとして信頼させていない。codesign は要求しない（信頼なしで署名できることを確認済み）。\n\n' +
      '自動ロックしない。ビルド途中でロックすると、消すために作ったものがパスワード要求を起こす。\n\n' +
      '証明書が無ければ ad-hoc に戻り、そう表示する。黙って別の方法で署名するのが、この問題が丸一日気づかれなかった理由。',
    source: '2026-08-22 「これって毎回許可しないといけない？」',
  },
  {
    key: 'agent_routing',
    title: 'エージェントの自動振り分け',
    domain: 'development',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P1',
    reason:
      '当初の想定は「頼めば得意なLLMに分配される」だったが、実装は既定で claude に渡すだけだった。' +
      '2種類のベンチマークを実測し、その結果に基づいて規則を書いた。',
    dependencies: ['coding_agent_dispatch_tool'],
    evidence: [
      'server/core/agent_choice.ts / scripts/test-agent-choice.ts（15件）/ scripts/benchmark-agents.ts',
      '2026-08-22 ベンチ1（仕様が完全な単体テスト作成）: claude $1.246/261秒/33項目、codex $0.018/131秒/7項目。' +
        '両方コミット。変異4件のうち codex が見逃したのは並び順の1件のみ',
      '2026-08-22 ベンチ2（設計判断を含む並び順の決定）: 両方が2案以上を検討し、退けた理由を書き、' +
        '仕様に無かった制約（表示側が6行で切ること）を独立に発見した。差なし',
      '2026-08-22 実測: Codex の通信は既定で閉（curl HTTP 000 / ping 100% loss / DNS bind 拒否）、' +
        'sandbox_workspace_write.network_access=true で HTTP 200',
    ],
    notes:
      '**得意分野は規則に入れていない。** 2回測って差が出なかった。事前の予想は「設計判断で差が出る」で、外れた。' +
      '2つの測定で専門性を主張すれば、根拠の薄さが忘れられた後も規則表に残る。\n\n' +
      '入っているのは、硬い制約（Codex は通信不可）と生の数字（各契約の週の残量）だけ。' +
      '％で比べるのは量の比較ではないが、問いは「どちらが先に使えなくなるか」なので、自分の枠に対する消費率が答えになる。\n\n' +
      '10ポイントの余裕を入れた。それ以下の差で毎回入れ替わると、誰が何を実行したかの記録が読めなくなる。\n\n' +
      '未測定: 30分を超える長い仕事での差。1種類目も2種類目も5分程度で、そこで差が出ないのは当然かもしれない。',
    source: '2026-08-22 「タスクごとに得意なLLMに振るとか」',
  },
  {
    key: 'unattended_budget',
    title: '無人実行の予算（週次の差分）',
    domain: 'safety',
    status: 'COMPLETED',
    verification: 'RUNTIME_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P0',
    reason:
      '上限が $5/日 だったが、定額契約では $ は実際に出ていく額ではない。' +
      '次に週の90%という絶対値にしたが、それは日中の監督下の使用と夜の暴走を足していた。' +
      '一続きの無人実行が、その間だけで週の5%を増やしたら止める。',
    dependencies: ['claude_allowance_relay'],
    evidence: [
      'server/core/allowance_gate.ts / scripts/test-allowance-gate.ts（23件）',
      '2026-08-22 実測: 基準点が .iris/unattended-budget.json に記録される（週87%時点）',
    ],
    notes:
      '基準点はディスクに置く。メモリだと再起動で消え、**「会計がゼロに戻った状態」は暴走が作り出す状態そのもの**なので、' +
      '試されている最中に上限が消える。\n\n' +
      '差分が静かに壊れる4通りをテストで押さえた。2時間の空白で新しい一続き。週のリセットでも新規 — ' +
      'これが無いと 2% を先週の 87% と比べて「返ってきた」と読み、以後どれだけ使っても超えない基準点が残る。' +
      '値が下がったら0に丸める。拒否した実行は記録しない。\n\n' +
      '監督下の起動には一切かからない。上限は「誰も見ていない作業」のためのもので、' +
      '目の前に残量が出ている人と自分の道具の間に調速機を挟む理由はない。\n\n' +
      '未確定: 5% という値。一晩走らせてから調整する。',
    source: '2026-08-22 「寝ている時の作業だけで5%増えたら辞めさせよう」',
  },
  {
    key: 'band_information_design',
    title: '帯の情報設計（何を出し、何を出さないか）',
    domain: 'ambient',
    status: 'COMPLETED',
    verification: 'REAL_WORLD_VERIFIED',
    reality: 'VERIFIED_PRESENT',
    priority: 'P2',
    reason:
      '常時見えている面は、読まなくてよいものを置くと邪魔になる。同じ不満を3回受けて、3回とも直し方を間違えた。',
    dependencies: [],
    evidence: [
      'menubar/IrisMenuBar.swift の lines(for:) / docs/hud-strip-design.md §8',
      '2026-08-22: 分数を4回作り直し、最終的に廃止した',
    ],
    notes:
      '**「完了 14/18」を3回指摘され、3回とも別の直し方をして外した。** 分母を説明する → プロジェクト別に割る → ' +
      '古いタスクを外す。正解は「分数をやめる」だった。無関係なものの合計は、どちらの都合とも関係なく動き、手の打ちようがない。\n\n' +
      '「着手中のものはありません」と表示しながら6つのセッションが開いていた。台帳の In Progress は人が手で立てる欄で、' +
      'セッションは観測できる事実。**観測できるものを観測する。**\n\n' +
      '「止まっているものが1件」→ 題名を出す → それでも伝わらない → 日付待ちと本当に詰まっているものを分ける。' +
      '唯一の blocked は 8/28 の観測窓を待っているだけで、「止まっている」が最も役に立たない言い方だった。\n\n' +
      '「iris が27分反応していません」は IRIS 自身が起動した使用量取得のセッションだった。' +
      '15分おきに来る誤報は、報せが無いより悪い。その行を無視する訓練になる。\n\n' +
      '$ を出していたが、定額契約では出ていかない額。出力トークンに替えた。\n\n' +
      '4つのブロックが同じ制約優先度で、入り切らないときに潰す対象がレイアウトエンジンの自由だった。' +
      'usage が消え、警告も省略記号も出ず、数字があった場所に隙間ができた。右から順に優先度を付けた。',
    source: '2026-08-22 帯についての一連の指摘',
  },
];
