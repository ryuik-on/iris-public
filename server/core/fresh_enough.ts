/**
 * 古い答えを即返して、裏で取り直す。
 *
 * 同じ形の手当てを三度別々に書いていた（セッション走査、CLI の使用量、そして
 * これから直す使用量の内訳）。**三度書くと、三度目に一つ忘れる** —— 実際に
 * 忘れたのは「取り直しが重なったときに一本にまとめる」ところで、忘れると
 * 重い走査が同時に何本も立つ。
 *
 * 決めていることは四つ。
 *
 *   **一度も取れていないときだけ待つ。**それ以外は手元の答えを返す。待つのは
 *   最初の一人だけで、二人目からは古いものを受け取る。
 *
 *   **古さを隠さない。**`peek()` が取れた時刻を返す。古い値を新しい顔で出すと、
 *   受け取った側はそれが古いことを知る術がない。
 *
 *   **取り直しは一本にまとめる。**古い答えを返している間に十の要求が来ても、
 *   走るのは一本。重い走査が並ぶと、直したはずの停止が戻る。
 *
 *   **失敗しても手元の答えは捨てない。**取り直せなかったことは、前の答えが
 *   間違いになったことではない。次に聞かれたときにまた試す。
 */

export interface Held<T> {
  value: T;
  /** 取れた時刻（ms）。 */
  at: number;
}

export class FreshEnough<T> {
  private held: Held<T> | null = null;
  private inFlight: Promise<void> | null = null;
  /** 取り直しが失敗した回数。**黙って古いものを返し続けないため。** */
  private failures = 0;

  constructor(
    /** これより新しければ取り直さない。 */
    private freshMs: number,
    private load: () => Promise<T>,
    private now: () => number = () => Date.now()
  ) {}

  /** 手元の答えとその時刻。無ければ null。 */
  peek(): Held<T> | null {
    return this.held ? { ...this.held } : null;
  }

  /** 手元の答えの古さ（ms）。無ければ null。 */
  ageMs(): number | null {
    return this.held ? this.now() - this.held.at : null;
  }

  /** 取り直しが続けて失敗している回数。 */
  failureCount(): number {
    return this.failures;
  }

  /** 次に聞かれたら取り直す。**手元の答えは捨てない。** */
  stale(): void {
    if (this.held) this.held.at = -Infinity;
  }

  /** 外から答えを入れる（別プロセスが取ってきた場合など）。 */
  accept(value: T): void {
    this.held = { value, at: this.now() };
    this.failures = 0;
  }

  /**
   * いまの答え。古ければ裏で取り直し、**手元にあるものをそのまま返す。**
   */
  async get(): Promise<T> {
    const held = this.held;
    if (held && this.now() - held.at < this.freshMs) return held.value;
    const refresh = this.refresh();
    if (held) {
      // 待たない。取り直しは走っているが、返すのは手元のもの。
      void refresh.catch(() => {});
      return held.value;
    }
    await refresh;
    if (!this.held) throw new Error('まだ一度も取れていません。');
    return this.held.value;
  }

  /** 取り直しを待つ（押した人だけ待たせたいとき）。 */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const value = await this.load();
        this.held = { value, at: this.now() };
        this.failures = 0;
      } catch (err) {
        this.failures++;
        // 手元の答えは残す。取り直せなかったことは、前の答えの誤りではない。
        if (!this.held) throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
