/**
 * 聞こえたものが、IRIS 自身の声か。
 *
 * 聞き耳を常時上げた 2026-09-29 に、塞がっていない穴として残っていた。
 * 割り込み判定（`barge_in.ts`）は**読み上げを止めるか**を決めるもので、
 * **答えるか**は別の判断だった —— 名前を含む文を IRIS 自身が読み上げると、
 * マイクがそれを拾い、名前があるので「呼ばれた」ことになり、IRIS が自分に
 * 答える。返事を文ごとに喋るようにして、声に出す回数が増えたぶん起きやすい。
 *
 * 設計として作らないと決めてある配置そのもの ——**マイクが自分から模型に
 * 話しかける輪**。だからここで切る。
 *
 * ## 喋っている最中に聞こえたもの全部を捨てはしない
 *
 * それをやると**割り込みが死ぬ。**人が被せて話したときこそ答えてほしい。
 * だから「鳴っている間に聞こえた」だけでは捨てず、**読み上げている文に
 * 似ているか**を見る。似ていれば自分の声、似ていなければ人の声。
 *
 * 判断は `barge_in.ts` の自己エコーと同じ考え方だが、あちらは部分文（partial）
 * を、こちらは確定した一文を見る。同じ関数にしないのは、**止める判断と
 * 答える判断で、間違え方の重さが違う**から —— 止め損ねても人は言い直せるが、
 * 自分に答え始めると輪になる。
 */

export interface SpokenUtterance {
  /** 実際に読み上げた文字列（読み仮名を当てたあとの形）。 */
  text: string | null;
  /** 読み上げる前の文。認識は標準的な表記で返すので、比べるのはこちら。 */
  original?: string | null;
  /** 鳴りはじめた時刻（ms）。 */
  startedAt: number | null;
}

export interface OwnVoiceOptions {
  /**
   * 鳴り終わってから、まだ自分の声が届きうる時間。
   *
   * 認識は音の少しあとに確定するので、鳴り終わった瞬間に切ると**最後の一文が
   * すり抜ける。**
   */
  tailMs?: number;
  /** 片方がもう片方に含まれるだけのとき、似ていると言うのに要る文字数。 */
  overlapChars?: number;
  /**
   * 丸ごと一致したときに要る文字数。
   *
   * **全部同じことと、一方が他方を含むことは、証拠の強さが違う。**
   * 「30問です」は5文字で、含む／含まれるの下限には届かないが、読み上げた文と
   * 丸ごと同じなら自分の声と見てよい。それでも下限を置くのは、「はい」だけで
   * 決めないため —— 相槌は誰でも言う。
   */
  exactChars?: number;
}

const DEFAULTS: Required<OwnVoiceOptions> = { tailMs: 1500, overlapChars: 6, exactChars: 3 };

export interface OwnVoiceVerdict {
  own: boolean;
  reason: 'not_speaking' | 'self_echo' | 'someone_else';
}

/** 比べる前に落とすもの。記号と空白は、声にも認識にも安定して残らない。 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[、。．，！？!?「」『』（）()・…ー〜~,.:;]/g, '');
}

/**
 * 聞こえた一文が、いま（または直前に）読み上げていたものか。
 *
 * `heardAt` を渡すのは、**聞こえた時刻で判断するため。**確定は遅れて届くので、
 * 届いた時刻で見ると、鳴り終わったあとの一文を人の声と読み違える。
 */
export function isOwnVoice(
  heard: string,
  speaking: SpokenUtterance | null,
  heardAt: number,
  options: OwnVoiceOptions = {}
): OwnVoiceVerdict {
  const { tailMs, overlapChars, exactChars } = { ...DEFAULTS, ...options };
  if (!speaking || speaking.startedAt === null) return { own: false, reason: 'not_speaking' };

  const said = fold(speaking.original || speaking.text || '');
  const back = fold(heard);
  if (!said || !back) return { own: false, reason: 'not_speaking' };

  // 鳴りはじめより前に聞こえたものは、自分の声ではありえない。
  if (heardAt + tailMs < speaking.startedAt) return { own: false, reason: 'not_speaking' };

  /*
   * 読み上げた文の一部として出てくるか。認識は途中から拾うことも、途中で
   * 切れることもあるので、**どちらかがどちらかに含まれていれば**同じものと見る。
   */
  if (said === back && back.length >= exactChars) return { own: true, reason: 'self_echo' };
  const long = said.length >= back.length ? said : back;
  const short = said.length >= back.length ? back : said;
  if (short.length >= overlapChars && long.includes(short)) return { own: true, reason: 'self_echo' };

  // 含まれていないなら、鳴っている最中でも人の声。**割り込みを殺さない。**
  return { own: false, reason: 'someone_else' };
}
