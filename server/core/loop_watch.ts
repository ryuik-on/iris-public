/**
 * サーバが止まった瞬間と、そのとき何が走っていたか。
 *
 * 2026-09-28 に、外から 100ms ごとに叩いて「最大 3.9秒 の停止が 240秒 に一度」
 * までは分かった。**何が止めたかは分からなかった。**周期の仕事は十数あり、
 * どれも数分ごとなので、時刻から当てるのは当て物になる。
 *
 * 当て物をやめるための計器。止まったことは見つけられるが、**見つけただけでは
 * 直せない** —— 止まっていた間に何が走っていたかを一緒に残す。
 *
 * 仕組みは単純で、それ以上を望まない。一定の間隔で目を覚まし、**約束の時刻から
 * どれだけ遅れて起きたか**を見る。遅れ＝その間ずっと誰かが輪を握っていた時間。
 * 誰が握っていたかは、仕事の側が名乗る（`during` / `begin`）。
 *
 * 名乗らない仕事の停止は `null` として残る。**名乗らないものを「無かった」に
 * しない** —— 名前の無い停止が続くなら、名乗っていない仕事が残っている。
 */

export interface Stall {
  /** 止まりはじめた時刻（ISO）。 */
  at: string;
  /** 止まっていた長さ（ms）。 */
  ms: number;
  /** そのとき走っていた仕事の名前。名乗っていなければ null。 */
  during: string | null;
}

/** 長くかかった一区間。**停止とは別の観点** —— 誰が時間を使ったか。 */
export interface SlowSpan {
  at: string;
  ms: number;
  label: string;
}

export class LoopWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: string[] = [];
  private stalls: Stall[] = [];
  private slow: SlowSpan[] = [];
  private lastAt = 0;

  constructor(
    /** 目を覚ます間隔。短すぎると自分が負荷になる。 */
    private everyMs = 200,
    /** これ以上の遅れだけ残す。短い遅れは普通の仕事の揺れ。 */
    private thresholdMs = 300,
    /** 覚えておく件数。**古いものから捨てる** —— 直近が読めれば足りる。 */
    private keep = 50,
    private now: () => number = () => Date.now(),
    /** これ以上かかった区間を残す。停止のしきい値とは別。 */
    private slowMs = 500
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastAt = this.now();
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 試験のため、外から一拍進める。 */
  tick(): void {
    const at = this.now();
    const late = at - this.lastAt - this.everyMs;
    this.lastAt = at;
    if (late < this.thresholdMs) return;
    this.stalls.push({
      // 止まりはじめた時刻。**気づいた時刻ではない。**
      at: new Date(at - late).toISOString(),
      ms: late,
      during: this.running[this.running.length - 1] ?? null,
    });
    if (this.stalls.length > this.keep) this.stalls.splice(0, this.stalls.length - this.keep);
  }

  /**
   * いま走っているものとして名乗る。返ったものを呼ぶと終わる。
   *
   * 入れ子になったときは**内側が名乗る** —— 止めているのは細かい方だから。
   */
  begin(label: string): () => void {
    this.running.push(label);
    const startedAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const at = this.running.lastIndexOf(label);
      if (at >= 0) this.running.splice(at, 1);
      /*
       * かかった時間も残す。**停止の名前付けとは別の観点。**
       *
       * 見張りは停止が終わったあとに気づくので、`await` を跨いだ仕事の同期部分は
       * 「不明」として残る（実測 2026-09-28、4.2秒 の停止が名乗り無しだった）。
       * 4秒 塞いだなら、**4秒 かかった区間のどれかがそれ** —— そこから辿れる。
       */
      const took = this.now() - startedAt;
      if (took >= this.slowMs) {
        this.slow.push({ at: new Date(startedAt).toISOString(), ms: took, label });
        if (this.slow.length > this.keep) this.slow.splice(0, this.slow.length - this.keep);
      }
    };
  }

  /** 外から一区間を記録する（GC のように、始まりを自分で囲めないもの）。 */
  record(label: string, ms: number, atMs = this.now() - ms): void {
    if (ms < this.slowMs) return;
    this.slow.push({ at: new Date(atMs).toISOString(), ms, label });
    if (this.slow.length > this.keep) this.slow.splice(0, this.slow.length - this.keep);
  }

  /** 長くかかった区間。新しいものが先。 */
  slowest(): SlowSpan[] {
    return [...this.slow].sort((a, b) => b.ms - a.ms);
  }

  /** 同期の仕事を名前つきで走らせる。 */
  during<T>(label: string, run: () => T): T {
    const end = this.begin(label);
    try {
      return run();
    } finally {
      end();
    }
  }

  /** 非同期の仕事を名前つきで走らせる。 */
  async around<T>(label: string, run: () => Promise<T>): Promise<T> {
    const end = this.begin(label);
    try {
      return await run();
    } finally {
      end();
    }
  }

  /** 直近の停止。新しいものが先。 */
  recent(): Stall[] {
    return [...this.stalls].reverse();
  }

  /**
   * 仕事ごとのまとめ。**回数と最悪を並べる** —— 一度の 4秒 と、毎分の 0.4秒 は
   * 違う問題で、合計だけでは同じに見える。
   */
  summary(): Array<{ during: string | null; count: number; worstMs: number; totalMs: number }> {
    const by = new Map<string, { during: string | null; count: number; worstMs: number; totalMs: number }>();
    for (const s of this.stalls) {
      const key = s.during ?? '\u0000';
      const held = by.get(key) ?? { during: s.during, count: 0, worstMs: 0, totalMs: 0 };
      held.count++;
      held.worstMs = Math.max(held.worstMs, s.ms);
      held.totalMs += s.ms;
      by.set(key, held);
    }
    return [...by.values()].sort((a, b) => b.worstMs - a.worstMs);
  }

  /** いま名乗っているもの。停止の最中に外から覗くために。 */
  current(): string[] {
    return [...this.running];
  }
}
