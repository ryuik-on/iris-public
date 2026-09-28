/**
 * 記録された失敗を、繰り返す前に止める。
 *
 * `experience.ts` の冒頭に、この穴がそのまま書いてある —— 同じ形で三度
 * 失敗した試みが三件あり、「Each was noticed, fixed, and then repeated」。
 * 記録は残った。**読まれなかった。**
 *
 * 読ませる仕組みを足しても直らない。`/api/experiences?recurring=true` は
 * 前からあり、MCP の `attempts` も開いた。それでも 2026-09-28 のこの
 * セッションは `npm test | grep` でスイートの合否を判定し（記録された失敗
 * そのもの）、出力を読み違えて「190 failed」と数えた。**思い出す口があること
 * と、思い出すことは別。**
 *
 * だから照合をコードにする。**散文は命令を照合できない。**
 * 「コマンドを ; で繋いで検証とコミットを続ける」という記録から、シェルの
 * 文字列が該当するかを決められるのは、その形を知っている述語だけ。
 *
 * その代わり、**覆えていない記録を隠さない。**判断についての失敗
 * （「ユニットテストが通ったことをもって実装が正しいと判断する」）は命令では
 * ないので、述語では捕まえられない。`coverage()` がそれを列挙する ——
 * **覚えているが止められないものを、覚えていないことと混ぜない。**
 */

export interface PlannedAction {
  /** これから走らせるシェルの文字列。 */
  command?: string;
  /**
   * この命令に乗る変更（hook が git から取る）。
   *
   * 命令の文字列だけでは足りない記録があるので足した。「テストが通ったから
   * 正しい」は命令の綴りに現れず、**何を変えたか**と**確かめたか**にしか現れない。
   */
  changedPaths?: string[];
  /**
   * このセッションで実機を動かした形跡があるか。
   *
   * `undefined` は「**分からない**」で、`false` ではない。分からないときは
   * 止めない —— 止める権限は記録と証拠から来ていて、証拠の欠落から来ていない。
   */
  realRunSeen?: boolean;
}

/** 照合に使う、記録された試みの最小の形。 */
export interface RecordedFailure {
  attempt: string;
  learned: string;
  observations: number;
}

export interface RepeatHit {
  attempt: string;
  learned: string;
  observations: number;
  /** 命令のどこが該当したか。**「該当した」だけでは直せない。** */
  found: string;
}

/**
 * 記録された試みと、シェルの文字列を結ぶ述語。
 *
 * `attempt` は記録の側の文言と**同じ文字列**にしてある。似た文を書いて
 * 照合すると、記録を書き直した日に静かに外れる。`coverage()` がその外れを
 * 見つけるのは、この一致に頼っている。
 */
interface Detector {
  attempt: string;
  find(action: PlannedAction): string | null;
}

/**
 * 引用の中身を落とす。
 *
 * `git commit -m "a; b"` の `;` は区切りではない。落とさないと、コミット文に
 * セミコロンを書いた日に止まる。
 */
function withoutQuoted(command: string): string {
  return withoutHeredocs(command).replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * ヒアドキュメントの中身を落とす。**本文はデータで、命令ではない。**
 *
 * これが無いと、文面に例を書いた瞬間に止まる。実測 2026-09-28: この規則を入れる
 * コミット自身が止められた —— コミット文に、止めたい形を例として引用していた。
 * 続いて、その事例を書き足すための編集コマンドまで止まった。**規則が自分を
 * 説明する文を禁止していた。**
 *
 * 引用符の場合と同じ話だが、ヒアドキュメントの本文は引用符で囲まれていないので
 * 別に落とす必要がある。
 */
function withoutHeredocs(command: string): string {
  // <<EOF / <<'EOF' / <<-"EOF" の区切り語を拾い、本文を区切り行まで捨てる。
  const closed = command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2\s*$/gm,
    '(heredoc)'
  );
  /*
   * 区切り語が閉じていないときは、そこから先を全部落とす。**閉じ忘れは本文が
   * 短いことを意味しない。**残しておくと、書きかけの本文だけが照合に残る。
   */
  return closed.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*$/, '(heredoc)');
}

const DETECTORS: Detector[] = [
  {
    attempt: 'コマンドを ; で繋いで検証とコミットを続ける',
    /*
     * `;` は前段の失敗を無視して次に進む。**検証の次がコミットのときだけ**
     * 言う —— `for f in a b; do …; done` の `;` は区切りであって無視ではない。
     */
    find(action) {
      const command = action.command ?? '';
      const bare = withoutQuoted(command);
      const parts = bare.split(';');
      if (parts.length < 2) return null;
      for (let i = 1; i < parts.length; i++) {
        if (!/\bgit\s+(commit|push|tag)\b/.test(parts[i])) continue;
        const before = parts.slice(0, i).join(';');
        if (!/\b(npm\s+(run\s+)?test|npm\s+test|tsc|tsx\s+scripts\/test|swiftc|npm\s+run\s+typecheck|npm\s+run\s+build)\b/.test(before)) continue;
        return `; の後ろに ${parts[i].trim().slice(0, 40)} があり、前に検証があります`;
      }
      return null;
    },
  },
  {
    attempt: 'npm test の出力を grep してスイートの合否を判定する',
    /*
     * スイートが途中で落ちると失敗行が出ない。**出ない失敗は grep に映らない**
     * ので、通過に見える。終了コードで判定する。
     *
     * 出力を眺めるための `| tail` は止めない。止めるのは、合否を**文字列から**
     * 決めようとしている形（grep / rg / ugrep / awk による数え上げや一致）。
     */
    find(action) {
      const command = withoutQuoted(action.command ?? '');
      if (!/\bnpm\s+(run\s+)?test\b/.test(command)) return null;
      const m = command.match(/\|\s*(grep|rg|ugrep|egrep|ag)\b[^|]*/);
      if (!m) return null;
      return `npm test の出力を ${m[1]} に渡しています`;
    },
  },
  {
    attempt: 'ユニットテストが通ったことをもって実装が正しいと判断する',
    /*
     * これは命令の綴りに現れない失敗で、しばらく「覚えているが止められない」側に
     * 置いてあった。判断そのものは掴めないが、**判断が行いに変わる瞬間**は掴める
     * —— 記録された場所（音声・カレンダー・権限）を変えて、実機を一度も動かさずに
     * コミットするところ。
     *
     * 記録の `learned` が「実機で回す」であって「テストを増やす」ではないのが根拠。
     * エコー判定・カレンダーの網羅・TCC の帰属は、いずれも実機で初めて壊れた。
     *
     * 三つの証拠が揃ったときだけ言う。揃わないうちに言うと、根拠のない禁止になる。
     */
    find(action) {
      const command = withoutQuoted(action.command ?? '');
      if (!/\bgit\s+(commit|push)\b/.test(command)) return null;
      // 分からない（undefined）ときは止めない。false のときだけ。
      if (action.realRunSeen !== false) return null;
      const risky = (action.changedPaths ?? []).filter(onlyRealMachineProves);
      if (!risky.length) return null;
      const shown = risky.slice(0, 3).join('、');
      const rest = risky.length > 3 ? ` ほか${risky.length - 3}件` : '';
      return `${shown}${rest} を変えていて、このセッションで実機を動かした形跡がありません`;
    },
  },
];

/**
 * 実機でしか壊れ方が分からない場所。
 *
 * 記録の `situation`（音声・カレンダー・権限まわりの実装）を、実際にあるファイルに
 * 割り当てたもの。**思いつきで広げない** —— ここに足すなら、その場所で実機で
 * 初めて壊れた記録があるときだけ。
 */
function onlyRealMachineProves(path: string): boolean {
  return (
    // 音声。エコー判定は自分の声で発火した
    /^server\/(services\/(speech_agent|speech_bridge|speech_text|tts|voice_loop)|core\/(barge_in|wake_word))\.ts$/.test(path) ||
    /^swift\/iris-speech\//.test(path) ||
    // カレンダー。Google だけでは4件見えていなかった
    /^server\/(services\/(calendar|google_calendar|caldav_calendar)|core\/(calendar_divergence|lecture_divergence|lecture_events))\.ts$/.test(path) ||
    // 権限。launchd 下で notDetermined になった
    /^server\/(core\/(local_permissions|access|privacy)|services\/(google_oauth|oauth_provider|oauth_store|grant_health))\.ts$/.test(path) ||
    // 盤と HUD。画面に出るものは画面でしか確かめられない
    /^menubar\/.+\.swift$/.test(path)
  );
}

/**
 * これからやろうとしていることが、記録された失敗と同じ形か。
 *
 * 記録の側が持っているものだけを返す。**述語が知っていても、記録に無い失敗は
 * 言わない** —— 止める権限は記録から来ていて、思いつきから来ていない。
 */
export function guardAgainstRepeats(action: PlannedAction, failures: RecordedFailure[]): RepeatHit[] {
  const byAttempt = new Map(failures.map((f) => [key(f.attempt), f]));
  const hits: RepeatHit[] = [];
  for (const d of DETECTORS) {
    const recorded = byAttempt.get(key(d.attempt));
    if (!recorded) continue;
    const found = d.find(action);
    if (!found) continue;
    hits.push({
      attempt: recorded.attempt,
      learned: recorded.learned,
      observations: recorded.observations,
      found,
    });
  }
  return hits;
}

/**
 * どの記録が止められて、どれが止められないか。
 *
 * **0件を「問題なし」と読ませないための欄。**覆えていない記録は、忘れた記録と
 * 同じ見え方をする。判断についての失敗（「テストが通ったから正しい」）は命令に
 * 現れないので、述語では捕まえられない —— 捕まえられないと言う。
 */
export function coverage(failures: RecordedFailure[]): {
  covered: string[];
  uncovered: string[];
  /** 述語はあるが、記録の側に該当が無いもの。文言を書き直すと起きる。 */
  orphanDetectors: string[];
} {
  const recorded = new Map(failures.map((f) => [key(f.attempt), f.attempt]));
  const detected = new Set(DETECTORS.map((d) => key(d.attempt)));
  return {
    covered: [...recorded].filter(([k]) => detected.has(k)).map(([, a]) => a),
    uncovered: [...recorded].filter(([k]) => !detected.has(k)).map(([, a]) => a),
    orphanDetectors: DETECTORS.filter((d) => !recorded.has(key(d.attempt))).map((d) => d.attempt),
  };
}

/**
 * 照合用の鍵。`experience.ts` の `attemptKey` と同じ粗さで、同じ理由。
 *
 * 写しではなく同じ粗さの別実装にしてあるのは、こちらが**記録の文言と述語の
 * 文言**を結ぶための鍵で、あちらが**二つの記録が同じ試みか**を決める鍵
 * だから。片方を細かくしたい日に、もう片方が一緒に動くと困る。
 */
function key(attempt: string): string {
  return attempt.toLowerCase().replace(/[\s　、。,.!?！？「」『』()（）・]/g, '');
}

/** 人に見せる一続きの文。命令を止めた理由は、止めた場所で全部言う。 */
export function explainHits(hits: RepeatHit[]): string {
  return hits
    .map(
      (h) =>
        `「${h.attempt}」は同じ形で ${h.observations} 回失敗しています（${h.found}）。\n` +
        `  → ${h.learned}`
    )
    .join('\n');
}
