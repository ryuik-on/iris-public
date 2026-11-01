/**
 * 連携の「使えない」を、しばらく続いたものだけ出す。
 *
 * ネットが切れた直後や、スリープから戻った直後は、予定の読み取りが一回こけて、数十秒で
 * 戻る。それを問題として出すと、直す手がないまま、利用者が見に来て不安になる。
 */
export class ProblemHold {
  private seen = new Map<string, number>();
  constructor(private afterMs = 180_000, private now: () => number = () => Date.now()) {}

  filter<T extends { id: string }>(problems: T[]): T[] {
    const t = this.now();
    const ids = new Set(problems.map((p) => p.id));
    for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
    return problems.filter((p) => {
      const since = this.seen.get(p.id) ?? t;
      this.seen.set(p.id, since);
      return t - since >= this.afterMs;
    });
  }

  clear(): void { this.seen.clear(); }
}
