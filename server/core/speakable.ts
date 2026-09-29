/**
 * 届きはじめた返事を、**声に出してよい単位**へ切る。
 *
 * 声の道は長いあいだ、返事が全部できてから喋り出していた
 * （`voice_loop.ts` の `await chat.sendMessage(...)` のあとに `speak(reply)`）。
 * 実測 2026-09-29、単純な問いで 1.35〜3.08秒。**その間は無音**で、喋り始めるのは
 * そのあと。「即座に会話ができる」から一番遠いのはモデルの速さではなく、
 * **最初の一声までの沈黙**だった。
 *
 * ここが決めるのは一つだけ ——「いま手元にある文字を、読み上げて意味を成すか」。
 *
 * ## 切ってはいけないところ
 *
 * **文の途中。**「今日は19時から」で切ると、続きが来るまでの間が文の内側に
 * 落ちる。人は文の切れ目では待てるが、文の途中では待てない。
 *
 * **数字と URL の中。**「3.5」の `.` は文の終わりではない。`http://…` の中の
 * 記号も同じ。区切りに見える字が、区切りでないことがある。
 *
 * **コード塊の中。**読み上げても意味を成さないが、途中で切るとなお悪い。
 *
 * ## 最初の一片だけ、短くてよい
 *
 * 二片目からは短いと途切れて聞こえるので下限を置く。**最初だけは別** ——
 * 削りたいのは沈黙で、「はい。」と言えるならその時点で言った方がいい。
 */

export interface SpeakableOptions {
  /** 最初の一片の下限。短いほど早く喋り出せる。 */
  firstMinChars?: number;
  /**
   * 二片目以降の下限。短すぎると途切れて聞こえる。
   *
   * 下限に足りない文は**捨てずに次とまとめる** —— 短い文が単独で飛ぶより、
   * 一息で続く方が聞きやすい。返事の最後に残った分は `flush` が出す。
   */
  minChars?: number;
  /** これを超えたら、読点でも切る —— 句点を待つと間が空きすぎる。 */
  maxChars?: number;
}

const ENDERS = new Set(['。', '．', '！', '？', '!', '?', '\n']);
/** 長くなったときだけ許す切れ目。 */
const SOFT = new Set(['、', '，', ',', '；', ';', '：', ':']);

export class Speakable {
  private pending = '';
  private emitted = 0;
  /** 開いているコード塊の中にいるか。``` の数で決める。 */
  private inCode = false;
  private readonly firstMinChars: number;
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(options: SpeakableOptions = {}) {
    // 3 文字。「はい。」がそのまま出る長さ —— 相槌を待たせる理由が無い。
    this.firstMinChars = options.firstMinChars ?? 3;
    this.minChars = options.minChars ?? 18;
    this.maxChars = options.maxChars ?? 60;
  }

  /** これまでに出した断片の数。最初かどうかの判定に使う。 */
  get pieces(): number {
    return this.emitted;
  }

  /** まだ出していない文字。 */
  get held(): string {
    return this.pending;
  }

  /**
   * 前の試行を捨てる。
   *
   * 作り直し（`reset`）は、**前の答えが無かったことになる**という報せ。まだ
   * 喋っていない分は捨てられるが、**既に声に出した分は取り消せない** ——
   * `pieces` が 0 でなければ、聞いた人は古い答えの一部を聞いている。
   * 取り消せないことを、黙って無かったことにしない（呼ぶ側が報せる）。
   */
  reset(): void {
    this.pending = '';
    this.inCode = false;
  }

  /** 届いた分を足して、喋ってよい断片を返す。 */
  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.pending.slice(0, cut).trim();
      this.pending = this.pending.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted++;
      }
    }
    return out;
  }

  /** 残りを全部出す。**言い残さない。** */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = '';
    this.inCode = false;
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }

  /** 切ってよい位置（その位置までを出す）。無ければ -1。 */
  private findCut(): number {
    const floor = this.emitted === 0 ? this.firstMinChars : this.minChars;
    const text = this.pending;
    let code = this.inCode;
    let lastSoft = -1;

    for (let i = 0; i < text.length; i++) {
      // ``` はコード塊の開け閉め。中では切らない。
      if (text.startsWith('```', i)) {
        code = !code;
        i += 2;
        continue;
      }
      if (code) continue;
      const ch = text[i];
      if (!ENDERS.has(ch) && !SOFT.has(ch)) continue;
      if (!this.isBoundary(text, i)) continue;

      // 終わりの記号が続くとき（「…!?」）は、最後まで取る。
      let end = i + 1;
      while (end < text.length && ENDERS.has(text[end]) && text[end] !== '\n') end++;
      if (ENDERS.has(ch)) {
        if (end >= floor) {
          this.inCode = code;
          return end;
        }
        // 下限に足りない。**捨てずに続きを待つ。**
        continue;
      }
      lastSoft = end;
    }

    // 句点が来ないまま長くなったら、読点で切る。待ちすぎるのも間になる。
    if (lastSoft >= floor && text.length >= this.maxChars) {
      this.inCode = code;
      return lastSoft;
    }
    return -1;
  }

  /**
   * その記号が本当に切れ目か。
   *
   * `.` は「3.5」「v1.2」「127.0.0.1」の中にも出る。URL の中の記号も同じ。
   * **区切りに見える字が区切りでないこと**を先に除く。
   */
  private isBoundary(text: string, i: number): boolean {
    const ch = text[i];
    if (this.insideUrl(text, i)) return false;
    if (ch === '.' || ch === ',' || ch === ':' || ch === ';') {
      const before = text[i - 1];
      const after = text[i + 1];
      // 数字に挟まれていれば小数や番地。
      if (before && after && /[0-9]/.test(before) && /[0-9]/.test(after)) return false;
      // 英字のあとの `.` は、次が空白か終端のときだけ文の終わり。
      if (ch === '.' && after !== undefined && !/[\s\n]/.test(after)) return false;
    }
    return true;
  }

  /** その位置が URL の中か。直前の空白までを見る。 */
  private insideUrl(text: string, i: number): boolean {
    let start = i;
    while (start > 0 && !/[\s\n]/.test(text[start - 1])) start--;
    const word = text.slice(start, i + 1);
    return /^(https?:\/\/|www\.)/i.test(word) || /^[\w.-]+\.(com|jp|org|net|io|dev)\b/i.test(word);
  }
}
